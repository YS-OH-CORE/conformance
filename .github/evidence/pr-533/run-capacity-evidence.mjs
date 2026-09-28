#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FIXTURE_MARKER, startCapacityProxy } from './capacity-proxy.mjs';

const GO_SDK_COMMIT = '827f90ba0c13edb546028df42fadc9f1211a4ff2';
const SPEC_VERSION = '2025-11-25';
const CLI_TIMEOUT_MS = 30000;
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string' },
  'baseline-sha': { type: 'string' }, 'candidate-sha': { type: 'string' },
  'typescript-source': { type: 'string' }, 'go-sdk': { type: 'string' },
  'sdk-modes': { type: 'string', default: 'typescript,go' },
  output: { type: 'string' }, 'suite-watchdog-ms': { type: 'string', default: '600000' },
  help: { type: 'boolean', default: false }
} });
if (values.help) {
  console.log('Usage: node run-capacity-evidence.mjs --baseline CHECKOUT --candidate CHECKOUT\n' +
    '  [--go-sdk PINNED_GO_CHECKOUT] [--typescript-source UNCHANGED_CHECKOUT]\n' +
    '  [--sdk-modes typescript,go] [--output NEW_DIR]\n' +
    '  [--baseline-sha SHA] [--candidate-sha SHA] [--suite-watchdog-ms 600000]');
  process.exit(0);
}
if (!values.baseline || !values.candidate) throw new Error('--baseline and --candidate are required (see --help)');
const sdkModes = values['sdk-modes'].split(',');
if (!sdkModes.length || new Set(sdkModes).size !== sdkModes.length ||
    sdkModes.some(mode => !['typescript', 'go'].includes(mode))) throw new Error('Invalid --sdk-modes');
if (sdkModes.includes('go') && !values['go-sdk']) throw new Error('--go-sdk is required when --sdk-modes includes go');
const suiteWatchdog = Number(values['suite-watchdog-ms']);
if (!Number.isSafeInteger(suiteWatchdog) || suiteWatchdog <= CLI_TIMEOUT_MS) throw new Error('Invalid outer suite watchdog');
const checkouts = { baseline: resolve(values.baseline), candidate: resolve(values.candidate) };
const tsSource = resolve(values['typescript-source'] ?? values.baseline);
const output = resolve(values.output ?? join(here, 'runs', new Date().toISOString().replaceAll(':', '-')));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse reuse: old checks must never contaminate new evidence.
const buildWork = join(output, 'build-work');
await mkdir(buildWork);
const env = { ...process.env, NO_COLOR: '1', GOWORK: 'off', GOTOOLCHAIN: 'local',
  GOCACHE: join(buildWork, 'go-cache'), GOMODCACHE: join(buildWork, 'go-mod-cache'),
  GOPATH: join(buildWork, 'go-path') };
const summary = {
  schemaVersion: 1, startedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  specVersion: SPEC_VERSION, cliScenarioTimeoutMs: CLI_TIMEOUT_MS, outerSuiteWatchdogMs: suiteWatchdog,
  sdkModes, cap: 4, conditions: ['clean', 'reject-prompts'], sources: {}, sdks: {}, runs: [],
  assertions: [], setupOrExecutionErrors: [],
  interpretation: {
    policyOwner: 'The cap and injected -32601 responses belong to the loopback fixture. SDK servers are unchanged.',
    measurement: 'Distinct SDK-issued initialize session IDs minus observed successful upstream DELETE releases.',
    timeoutBoundary: 'The existing CLI retains its 30-second per-scenario timeout; the outer watchdog only stops a stuck whole CLI.',
    knownScopeLimit: 'The raw DNS-rebinding probe bypasses ctx.connect and does not DELETE its accepted session. Retain that residual; compare each negative run with its own clean control.',
    assertionsChosenBeforeExecution: true,
    conformanceVerdicts: 'Only the existing CLI computes conformance verdicts. Lab assertions assess experimental invariants, not SDK conformance.'
  }
};
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const saveSummary = () => json(join(output, 'summary.json'), summary);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const liveProcesses = new Set();

function signalChild(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function launch(directory, name, command, args, cwd, extraEnv = {}, onStdout = () => {}) {
  if (summary.interruptedBySignal) throw new Error(`Interrupted by ${summary.interruptedBySignal}; no further process will be launched`);
  const stdoutPath = join(directory, `${name}.stdout.log`);
  const stderrPath = join(directory, `${name}.stderr.log`);
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const state = { command, args, cwd, environmentOverrides: extraEnv, startedAt: new Date().toISOString(),
    exitCode: null, signal: null, launchError: null, timedOut: false, closed: false, logErrors: [] };
  for (const stream of [stdout, stderr]) stream.on('error', error => state.logErrors.push(String(error)));
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  liveProcesses.add(child);
  child.stdout.on('data', data => { stdout.write(data); onStdout(data.toString('utf8')); });
  child.stderr.on('data', data => stderr.write(data));
  child.once('error', error => { state.launchError = String(error); });
  const completion = new Promise(resolveDone => child.once('close', async (exitCode, signal) => {
    liveProcesses.delete(child);
    Object.assign(state, { exitCode, signal, closed: true, finishedAt: new Date().toISOString() });
    await Promise.all([new Promise(done => stdout.end(done)), new Promise(done => stderr.end(done))]);
    await json(join(directory, `${name}.invocation.json`), state);
    resolveDone(state);
  }));
  return { child, state, completion };
}

async function execute(directory, name, command, args, cwd, timeout = 60000, extraEnv, onStdout) {
  const job = launch(directory, name, command, args, cwd, extraEnv, onStdout);
  const timer = setTimeout(() => { job.state.timedOut = true; signalChild(job.child, 'SIGKILL'); }, timeout);
  try { return await job.completion; } finally { clearTimeout(timer); }
}

async function checked(name, command, args, cwd, timeout = 60000) {
  const result = await execute(output, name, command, args, cwd, timeout);
  if (result.exitCode !== 0 || result.launchError || result.timedOut || result.logErrors.length) {
    throw new Error(`${name} failed; full invocation/stdout/stderr retained`);
  }
  return readFile(join(output, `${name}.stdout.log`), 'utf8');
}

async function sourceProvenance(label, checkout, expectedSha) {
  const commit = (await checked(`${label}-revision`, 'git', ['rev-parse', 'HEAD'], checkout)).trim();
  if (expectedSha && commit !== expectedSha) throw new Error(`${label} expected ${expectedSha}, found ${commit}`);
  const status = await checked(`${label}-status`, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], checkout);
  const patch = await checked(`${label}-working-tree-patch`, 'git', ['diff', '--binary', 'HEAD'], checkout);
  const names = (await checked(`${label}-source-files`, 'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z',
    'src', 'examples/servers/typescript', 'package.json', 'package-lock.json', 'tsconfig.json'], checkout)).split('\0').filter(Boolean);
  const manifest = [];
  for (const name of [...new Set(names)].sort()) {
    try { manifest.push({ path: name, sha256: sha256(await readFile(join(checkout, name))) }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      manifest.push({ path: name, deleted: true });
    }
  }
  await json(join(output, `${label}-source-manifest.json`), manifest);
  return { checkout, commit, status, workingTreePatchSha256: sha256(patch),
    sourceSha256: sha256(JSON.stringify(manifest)), manifestPath: `${label}-source-manifest.json` };
}

async function directoryManifest(directory) {
  const entries = [];
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) entries.push({ path: relative(directory, full), sha256: sha256(await readFile(full)) });
    }
  }
  await walk(directory);
  return { sha256: sha256(JSON.stringify(entries)), files: entries };
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function portOpen(port) {
  return new Promise(resolveProbe => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = answer => { socket.destroy(); resolveProbe(answer); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function stop(job) {
  if (!job.state.closed) signalChild(job.child, 'SIGTERM');
  const timer = setTimeout(() => { if (!job.state.closed) signalChild(job.child, 'SIGKILL'); }, 5000);
  try { return await job.completion; } finally { clearTimeout(timer); }
}

async function ready(job, port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !job.state.closed) {
    if (await portOpen(port)) return;
    await delay(50);
  }
  throw new Error(`SDK server did not become ready: ${job.state.launchError ?? 'see retained server logs'}`);
}

async function collectChecks(directory) {
  const entries = [];
  const errors = [];
  async function walk(path) {
    for (const file of await readdir(path, { withFileTypes: true })) {
      const full = join(path, file.name);
      if (file.isDirectory()) await walk(full);
      else if (file.name === 'checks.json') {
        try {
          const checks = JSON.parse(await readFile(full, 'utf8'));
          if (!Array.isArray(checks)) throw new Error('checks.json is not an array');
          const scenario = /server-(.+)-\d{4}-\d{2}-\d{2}T/.exec(full.split('/').at(-2))?.[1] ?? null;
          entries.push({ path: relative(output, full), scenario, checks });
        } catch (error) { errors.push({ path: relative(output, full), error: String(error) }); }
      }
    }
  }
  await walk(directory);
  return { entries, errors };
}

const checkStatuses = (run, predicate = () => true) => run.checks.filter(entry => predicate(entry.scenario))
  .flatMap(entry => entry.checks.map(check => [entry.scenario, check.id, check.status]))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const residualOrigins = run => run.beforeTeardown.liveSessions
  .map(session => ({ clientName: session.clientName, protocolVersionRequested: session.protocolVersionRequested,
    observedRpcMethods: [...session.observedRpcMethods].sort() }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function assert(scope, name, passed, details = {}) {
  summary.assertions.push({ scope, name, passed: Boolean(passed), ...details });
}

async function runCase(mode, label, condition) {
  const directory = join(output, mode, label, condition);
  await mkdir(join(directory, 'results'), { recursive: true });
  const run = { sdk: mode, head: label, condition, directory: relative(output, directory),
    selectedScenarios: [], scenarioBoundaries: [], checks: [], checksReadErrors: [], setupOrExecutionError: null };
  summary.runs.push(run);
  await saveSummary();
  let server;
  let proxy;
  try {
    const port = await reservePort();
    const sdk = summary.sdks[mode];
    const serverArgs = mode === 'typescript' ? ['--import', sdk.tsxLoader, sdk.serverPath]
      : ['-http', `127.0.0.1:${port}`, '-stateless=false'];
    server = launch(directory, 'server', mode === 'typescript' ? process.execPath : sdk.binary,
      serverArgs, mode === 'typescript' ? tsSource : buildWork, mode === 'typescript' ? { PORT: String(port) } : {});
    await ready(server, port);
    let currentScenario = null;
    proxy = await startCapacityProxy({ target: `http://127.0.0.1:${port}${mode === 'typescript' ? '/mcp' : '/'}`,
      eventsPath: join(directory, 'http-events.jsonl'), rejectPrompts: condition === 'reject-prompts',
      cap: 4, scenario: () => currentScenario });
    let stdoutRemainder = '';
    const observeStdout = chunk => {
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split('\n');
      stdoutRemainder = lines.pop();
      for (const line of lines) {
        const match = /^=== Running scenario: (.+) ===\s*$/.exec(line.replace(/\u001b\[[0-9;]*m/g, ''));
        if (match) {
          currentScenario = match[1];
          run.selectedScenarios.push(currentScenario);
          const state = proxy.snapshot(`cli-scenario-marker:${currentScenario}`);
          run.scenarioBoundaries.push({ scenario: currentScenario, liveSessionIds: state.liveSessionIds,
            pendingInitializeRequestIds: state.pendingInitializeRequestIds });
        }
      }
    };
    const args = ['dist/index.js', 'server', '--url', proxy.url, '--suite', 'active',
      '--spec-version', SPEC_VERSION, '--timeout', String(CLI_TIMEOUT_MS), '-o', join(directory, 'results')];
    run.cli = await execute(directory, 'cli', process.execPath, args, checkouts[label], suiteWatchdog, {}, observeStdout);
    run.atCliExit = proxy.snapshot('at-cli-exit');
    // Identical, recorded allowance for socket-close events already in flight.
    // This cannot release a session: only observed successful DELETE can do so.
    await delay(250);
    run.beforeTeardown = proxy.snapshot('before-server-or-proxy-teardown-after-250ms');
    const collected = await collectChecks(join(directory, 'results'));
    run.checks = collected.entries;
    run.checksReadErrors = collected.errors;
    run.counts = run.checks.flatMap(entry => entry.checks).reduce((counts, check) => {
      counts[check.status] = (counts[check.status] ?? 0) + 1;
      return counts;
    }, { SUCCESS: 0, FAILURE: 0, WARNING: 0, INFO: 0, SKIPPED: 0 });
    const printed = (await readFile(join(directory, 'cli.stdout.log'), 'utf8')).replace(/\u001b\[[0-9;]*m/g, '');
    const match = /^Total: (\d+) passed, (\d+) failed(?:, (\d+) warnings)?\s*$/m.exec(printed);
    run.printedTotals = match ? { passed: Number(match[1]), failed: Number(match[2]),
      warnings: match[3] === undefined ? null : Number(match[3]) } : null;
    const scope = `${mode}/${label}/${condition}`;
    assert(scope, 'CLI completed without outer watchdog or launch/log failure', !run.cli.timedOut &&
      !run.cli.signal && !run.cli.launchError && !run.cli.logErrors.length && run.cli.exitCode !== null);
    assert(scope, 'Every CLI-selected scenario has retained checks', run.selectedScenarios.length > 0 &&
      !run.checksReadErrors.length && same([...run.selectedScenarios].sort(), run.checks.map(entry => entry.scenario).sort()));
    assert(scope, 'CLI printed pass/failure totals agree with retained checks',
      run.printedTotals?.passed === run.counts.SUCCESS && run.printedTotals?.failed === run.counts.FAILURE);
    assert(scope, 'Observed issued-session capacity never exceeded four', run.beforeTeardown.maxLiveSessions <= 4 &&
      run.beforeTeardown.maxLivePlusPendingInitializes <= 4);
    assert(scope, 'All initialize admissions settled', run.beforeTeardown.pendingInitializeRequestIds.length === 0);
    assert(scope, 'Stateful SDK actually issued sessions', run.beforeTeardown.issuedSessionIds > 0 &&
      run.beforeTeardown.initializeWithoutSessionId === 0 && run.beforeTeardown.sessionIdReissues === 0);
    assert(scope, 'No unexpected proxy transport failures or journal errors',
      run.beforeTeardown.upstreamFailures === 0 && !run.beforeTeardown.journalErrors.length);
    const firstPrompt = run.beforeTeardown.firstPromptRequest;
    assert(scope, 'The first actual prompt request had no other outstanding sessions or pending initializes', firstPrompt &&
      firstPrompt.otherLiveSessionIds.length === 0 && firstPrompt.pendingInitializeRequestIds.length === 0,
      { firstPromptRequest: firstPrompt });
    if (condition === 'clean') {
      assert(scope, 'Clean control had no fixture cap or prompt denials', run.beforeTeardown.fixtureCapDenials === 0 &&
        run.beforeTeardown.fixturePromptRejections === 0);
    } else {
      assert(scope, 'Injected prompt errors were exercised and CLI retained a failing verdict',
        run.beforeTeardown.fixturePromptRejections > 0 && run.cli.exitCode === 1);
      if (label === 'baseline') assert(scope, 'Baseline prompt failures exhausted the actual fixture cap',
        run.beforeTeardown.fixtureCapDenials > 0);
      else {
        assert(scope, 'Candidate had no fixture cap denials', run.beforeTeardown.fixtureCapDenials === 0);
        const promptIds = run.beforeTeardown.injectedPromptSessionIds;
        assert(scope, 'Every injected prompt session received exactly one successful DELETE', promptIds.length > 0 &&
          promptIds.every(id => run.beforeTeardown.sessions.some(session => session.sessionId === id &&
            session.releasedByDelete && session.deleteAttempts === 1)), { sessionIds: promptIds });
        assert(scope, 'Candidate sent no duplicate DELETE requests', run.beforeTeardown.duplicateDeleteRequests === 0);
        const failures = run.checks.flatMap(entry => entry.checks.filter(check => check.status === 'FAILURE')
          .map(check => ({ scenario: entry.scenario, id: check.id, errorMessage: check.errorMessage })));
        assert(scope, 'Candidate failures are only the intentionally injected prompt errors', failures.length > 0 &&
          failures.every(check => check.scenario?.startsWith('prompts-') && String(check.errorMessage).includes(FIXTURE_MARKER)), { failures });
      }
    }
    console.log(`${scope}: CLI exit=${run.cli.exitCode}; checks=${JSON.stringify(run.counts)}; ` +
      `issued=${run.beforeTeardown.issuedSessionIds}; DELETE releases=${run.beforeTeardown.successfulDeleteReleases}; ` +
      `residual=${run.beforeTeardown.liveSessionIds.length}; cap denials=${run.beforeTeardown.fixtureCapDenials}`);
  } catch (error) {
    run.setupOrExecutionError = String(error?.stack ?? error);
    summary.setupOrExecutionErrors.push({ sdk: mode, head: label, condition, error: run.setupOrExecutionError });
    if (proxy && !run.beforeTeardown) run.beforeTeardown = proxy.snapshot('execution-error-before-teardown');
    console.error(`${mode}/${label}/${condition}: ${error}`);
  } finally {
    if (proxy) run.afterTeardown = await proxy.close();
    if (server) run.server = await stop(server);
    await json(join(directory, 'run-summary.json'), run);
    await saveSummary();
  }
}

// Retain completed logs on an interrupted local run. SIGKILL cannot be handled.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  summary.interruptedBySignal = signal;
  for (const child of liveProcesses) signalChild(child, 'SIGKILL');
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
});

try {
  await copyFile(join(here, 'run-capacity-evidence.mjs'), join(output, 'run-capacity-evidence.mjs'));
  await copyFile(join(here, 'capacity-proxy.mjs'), join(output, 'capacity-proxy.mjs'));
  await copyFile(join(here, 'README.md'), join(output, 'preparation-README.md'));
  for (const [label, checkout] of Object.entries(checkouts)) {
    summary.sources[label] = await sourceProvenance(label, checkout, values[`${label}-sha`]);
    await checked(`${label}-build`, 'npm', ['run', 'build'], checkout, 120000);
    const built = await directoryManifest(join(checkout, 'dist'));
    summary.sources[label].builtDistSha256 = built.sha256;
    await json(join(output, `${label}-dist-manifest.json`), built.files);
  }
  if (sdkModes.includes('typescript')) {
    const serverRelative = 'examples/servers/typescript/everything-server.ts';
    const serverPath = join(tsSource, serverRelative);
    const source = await sourceProvenance('typescript-server-checkout', tsSource);
    const committedServer = await checked('typescript-server-committed-source', 'git', ['show', `HEAD:${serverRelative}`], tsSource);
    const serverBytes = await readFile(serverPath);
    if (sha256(serverBytes) !== sha256(committedServer)) throw new Error('TypeScript everything-server must be unchanged from its checkout HEAD');
    const installedSdk = join(tsSource, 'node_modules/@modelcontextprotocol/sdk');
    const sdkPackage = JSON.parse(await readFile(join(installedSdk, 'package.json'), 'utf8'));
    const sdkManifest = await directoryManifest(installedSdk);
    await json(join(output, 'typescript-installed-sdk-manifest.json'), sdkManifest.files);
    const tsxRoot = join(tsSource, 'node_modules/tsx');
    const tsxPackage = JSON.parse(await readFile(join(tsxRoot, 'package.json'), 'utf8'));
    const tsxExport = tsxPackage.exports?.['.'];
    if (typeof tsxExport !== 'string') throw new Error('Installed tsx must expose its Node import loader as the package root export');
    const tsxLoaderPath = join(tsxRoot, tsxExport);
    const tsxLoader = pathToFileURL(tsxLoaderPath).href;
    summary.sdks.typescript = { source, serverPath, serverSha256: sha256(serverBytes), tsxLoader,
      tsxVersion: tsxPackage.version, tsxLoaderSha256: sha256(await readFile(tsxLoaderPath)),
      version: sdkPackage.version, installedSdkSha256: sdkManifest.sha256,
      sharedAcrossHeadsAndConditions: true };
    await execute(output, 'typescript-dependency-tree', 'npm', ['ls', '--depth=0', '--json'], tsSource);
  }
  if (sdkModes.includes('go')) {
    const sdk = resolve(values['go-sdk']);
    const commit = (await checked('go-sdk-revision', 'git', ['rev-parse', 'HEAD'], sdk)).trim();
    if (commit !== GO_SDK_COMMIT) throw new Error(`Go SDK must be pinned to ${GO_SDK_COMMIT}, found ${commit}`);
    const status = await checked('go-sdk-status', 'git', ['status', '--porcelain=v1', '--untracked-files=all'], sdk);
    if (status.trim()) throw new Error('Go SDK checkout must be unmodified and have no untracked source additions');
    summary.runtime.go = (await checked('go-version', 'go', ['version'], buildWork)).trim();
    const module = join(buildWork, 'go-build-module');
    await mkdir(module);
    await writeFile(join(module, 'go.mod'), `module example.com/mcp533-capacity-evidence\n\ngo 1.25.0\n\n` +
      `require github.com/modelcontextprotocol/go-sdk v0.0.0\n\nreplace github.com/modelcontextprotocol/go-sdk => ${JSON.stringify(sdk)}\n`);
    const binary = join(buildWork, 'go-everything-server');
    await checked('go-everything-build', 'go', ['build', '-mod=mod', '-o', binary,
      'github.com/modelcontextprotocol/go-sdk/conformance/everything-server'], module, 300000);
    await checked('go-modules', 'go', ['list', '-m', '-json', 'all'], module);
    await checked('go-binary-metadata', 'go', ['version', '-m', binary], module);
    for (const file of ['go.mod', 'go.sum']) await copyFile(join(module, file), join(output, `build.${file}`));
    summary.sdks.go = { checkout: sdk, commit, binary, binarySha256: sha256(await readFile(binary)),
      goModSha256: sha256(await readFile(join(sdk, 'go.mod'))),
      goSumSha256: sha256(await readFile(join(sdk, 'go.sum'))), stateless: false, sharedAcrossHeadsAndConditions: true };
  }
  await saveSummary();
  matrix: for (const mode of sdkModes) {
    for (const label of ['baseline', 'candidate']) {
      for (const condition of ['clean', 'reject-prompts']) {
        if (summary.interruptedBySignal) break matrix;
        await runCase(mode, label, condition);
      }
    }
    const find = (head, condition) => summary.runs.find(run => run.sdk === mode && run.head === head && run.condition === condition);
    const baseClean = find('baseline', 'clean');
    const candidateClean = find('candidate', 'clean');
    const candidateErrors = find('candidate', 'reject-prompts');
    const complete = [baseClean, candidateClean, candidateErrors].every(run => !run.setupOrExecutionError && run.cli && run.beforeTeardown);
    assert(mode, 'Comparison controls completed', complete);
    if (complete) {
      assert(mode, 'Clean CLI verdicts and per-check statuses agree between heads',
        baseClean.cli.exitCode === candidateClean.cli.exitCode && same(checkStatuses(baseClean), checkStatuses(candidateClean)));
      assert(mode, 'Clean residual session origins agree between heads', same(residualOrigins(baseClean), residualOrigins(candidateClean)),
        { baselineResidualOrigins: residualOrigins(baseClean), candidateResidualOrigins: residualOrigins(candidateClean) });
      assert(mode, 'Candidate prompt errors add no residual sessions beyond its clean control',
        same(residualOrigins(candidateClean), residualOrigins(candidateErrors)),
        { cleanResidualOrigins: residualOrigins(candidateClean), injectedResidualOrigins: residualOrigins(candidateErrors) });
      assert(mode, 'Candidate non-prompt check statuses remain unchanged under injection',
        same(checkStatuses(candidateClean, name => !name?.startsWith('prompts-')),
          checkStatuses(candidateErrors, name => !name?.startsWith('prompts-'))));
      const promptScenarios = candidateErrors.selectedScenarios.filter(name => name.startsWith('prompts-'));
      assert(mode, 'Candidate reached an injected request in every CLI-selected prompt scenario',
        candidateErrors.beforeTeardown.fixturePromptRejections === promptScenarios.length &&
        candidateErrors.beforeTeardown.injectedPromptSessionIds.length === promptScenarios.length,
        { selectedPromptScenarios: promptScenarios });
    }
  }
} catch (error) {
  summary.setupOrExecutionErrors.push({ stage: 'setup-or-matrix', error: String(error?.stack ?? error) });
  console.error(error);
} finally {
  summary.finishedAt = new Date().toISOString();
  summary.allAssertionsPassed = summary.setupOrExecutionErrors.length === 0 && !summary.interruptedBySignal &&
    summary.runs.length === sdkModes.length * 4 && summary.assertions.length > 0 && summary.assertions.every(assertion => assertion.passed);
  await saveSummary();
  if (summary.interruptedBySignal) process.exitCode = summary.interruptedBySignal === 'SIGINT' ? 130 : 143;
  else if (!summary.allAssertionsPassed) process.exitCode = 1;
  console.log(`Evidence retained in ${output}; experiment assertions passed=${summary.allAssertionsPassed}`);
}
