import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SDK_COMMIT = '827f90ba0c13edb546028df42fadc9f1211a4ff2';
const BASE_COMMIT = '7169291ec0b68eb370fddcd9947313ab0d5e4156';
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  candidate: { type: 'string' }, baseline: { type: 'string' }, sdk: { type: 'string' },
  output: { type: 'string' }, 'suite-modes': { type: 'string', default: 'stateful' },
  'suite-timeout-ms': { type: 'string', default: '600000' }
} });
if (!values.candidate || !values.baseline || !values.sdk) {
  throw new Error('Usage: node run-go-evidence.mjs --candidate CHECKOUT --baseline CHECKOUT --sdk GO_SDK_CHECKOUT [--output NEW_DIR] [--suite-modes stateful,stateless]');
}
const output = resolve(values.output ?? join(here, 'runs', new Date().toISOString().replaceAll(':', '-')));
const candidate = resolve(values.candidate);
const baseline = resolve(values.baseline);
const sdk = resolve(values.sdk);
const suiteModes = values['suite-modes'].split(',');
if (!suiteModes.length || new Set(suiteModes).size !== suiteModes.length ||
    suiteModes.some(mode => !['stateful', 'stateless'].includes(mode))) {
  throw new Error('--suite-modes accepts stateful, stateless, or stateful,stateless');
}
const suiteTimeout = Number(values['suite-timeout-ms']);
if (!Number.isFinite(suiteTimeout) || suiteTimeout < 30000) throw new Error('Invalid suite timeout');
// A fresh directory prevents overwritten logs or old checks from contaminating a run.
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const work = join(output, 'build-work');
await mkdir(work);
const env = { ...process.env, NO_COLOR: '1', GOCACHE: join(work, 'go-cache'),
  GOMODCACHE: join(work, 'go-mod-cache'), GOPATH: join(work, 'go-path') };

function launch(command, args, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { command, args, cwd, stdout: '', stderr: '', exitCode: null,
    signal: null, launchError: null, closed: false, timedOut: false };
  child.stdout.on('data', data => { state.stdout += data; });
  child.stderr.on('data', data => { state.stderr += data; });
  child.once('error', error => { state.launchError = String(error); });
  const completion = new Promise(resolveDone => child.once('close', (exitCode, signal) => {
    Object.assign(state, { exitCode, signal, closed: true });
    resolveDone(state);
  }));
  return { child, state, completion };
}

async function execute(command, args, cwd, timeout = 60000) {
  const process = launch(command, args, cwd);
  const timer = setTimeout(() => { process.state.timedOut = true; process.child.kill('SIGKILL'); }, timeout);
  try { return await process.completion; } finally { clearTimeout(timer); }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

async function saveProcess(directory, name, result) {
  await writeFile(join(directory, `${name}.stdout.log`), result.stdout);
  await writeFile(join(directory, `${name}.stderr.log`), result.stderr);
  const { stdout, stderr, ...metadata } = result;
  await writeJson(join(directory, `${name}.invocation.json`), metadata);
}

async function checkedCommand(name, command, args, cwd, timeout = 60000) {
  const result = await execute(command, args, cwd, timeout);
  await saveProcess(output, name, result);
  if (result.exitCode !== 0 || result.launchError || result.timedOut) {
    throw new Error(`${name} failed; full stdout/stderr retained in ${output}`);
  }
  return result;
}

async function checkedRevision(checkout, expected, label) {
  const revision = await checkedCommand(`${label}-revision`, 'git', ['rev-parse', 'HEAD'], checkout);
  const sha = revision.stdout.trim();
  if (expected && sha !== expected) throw new Error(`${label} must be ${expected}; found ${sha}`);
  return sha;
}

async function collectChecks(directory) {
  const entries = [];
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) entries.push(...await collectChecks(path));
    else if (file.name === 'checks.json') entries.push({ path: relative(output, path), checks: JSON.parse(await readFile(path, 'utf8')) });
  }
  return entries;
}

function totals(entries) {
  return entries.flatMap(entry => entry.checks).reduce((result, check) => {
    result[check.status] = (result[check.status] ?? 0) + 1;
    return result;
  }, { SUCCESS: 0, FAILURE: 0, WARNING: 0 });
}

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolveListen);
  });
  const port = listener.address().port;
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function portIsOpen(port) {
  return await new Promise(resolveProbe => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    const finish = answer => { socket.destroy(); resolveProbe(answer); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function stopServer(server) {
  if (!server.state.closed) server.child.kill('SIGTERM');
  const timer = setTimeout(() => { if (!server.state.closed) server.child.kill('SIGKILL'); }, 7000);
  try { await server.completion; } finally { clearTimeout(timer); }
}

async function startServer(binary, args, directory, knownPort) {
  const server = launch(binary, args, directory);
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline && !server.state.closed) {
      if (knownPort && await portIsOpen(knownPort)) return { ...server, url: `http://127.0.0.1:${knownPort}` };
      if (!knownPort) {
        for (const line of server.state.stdout.split('\n')) {
          try {
            const ready = JSON.parse(line);
            if (typeof ready.url === 'string') return { ...server, url: ready.url };
          } catch { /* Server output is retained verbatim; only JSON readiness is recognized. */ }
        }
      }
      await delay(50);
    }
    throw new Error(`Go server did not become ready: ${server.state.launchError ?? server.state.stderr}`);
  } catch (error) {
    await stopServer(server);
    await saveProcess(directory, 'server', server.state);
    throw error;
  }
}

const summary = { recordedAt: new Date().toISOString(), runtime: { node: process.version,
  platform: process.platform, architecture: process.arch }, sdk: {}, sources: {},
  specVersion: '2025-11-25', suiteModes, runs: [], assertions: [],
  singleScenarioResidualGap: 'Faithful PR410 scope leaves an unbaselined WARNING-only single scenario at exit 0 on both revisions.' };
const saveSummary = () => writeJson(join(output, 'summary.json'), summary);

try {
  summary.sdk.commit = await checkedRevision(sdk, SDK_COMMIT, 'sdk');
  const sdkStatus = await checkedCommand('sdk-source-status', 'git', ['status', '--porcelain', '--untracked-files=no'], sdk);
  if (sdkStatus.stdout.trim()) throw new Error('SDK tracked sources must be unmodified');
  summary.sources.baseline = await checkedRevision(baseline, BASE_COMMIT, 'baseline');
  summary.sources.candidate = await checkedRevision(candidate, null, 'candidate');
  const goVersion = await checkedCommand('go-version', 'go', ['version'], work);
  summary.runtime.go = goVersion.stdout.trim();
  for (const filename of ['go.mod', 'go.sum']) {
    summary.sdk[`${filename}Sha256`] = createHash('sha256').update(await readFile(join(sdk, filename))).digest('hex');
  }
  const moduleDir = join(work, 'fixture');
  await mkdir(moduleDir);
  await copyFile(join(here, 'go-fixture/main.go'), join(moduleDir, 'main.go'));
  await writeFile(join(moduleDir, 'go.mod'), `module example.com/mcp410-go-evidence\n\ngo 1.25.0\n\nrequire github.com/modelcontextprotocol/go-sdk v0.0.0\n\nreplace github.com/modelcontextprotocol/go-sdk => ${JSON.stringify(sdk)}\n`);
  await checkedCommand('go-mod-tidy', 'go', ['mod', 'tidy'], moduleDir, 300000);
  const fixtureBinary = join(work, 'minimal-go-server');
  const everythingBinary = join(work, 'go-everything-server');
  await checkedCommand('go-fixture-build', 'go', ['build', '-o', fixtureBinary, '.'], moduleDir, 300000);
  await checkedCommand('go-everything-build', 'go', ['build', '-mod=mod', '-o', everythingBinary,
    'github.com/modelcontextprotocol/go-sdk/conformance/everything-server'], moduleDir, 300000);
  await checkedCommand('go-modules', 'go', ['list', '-m', '-json', 'all'], moduleDir);
  await checkedCommand('go-binary-metadata', 'go', ['version', '-m', fixtureBinary, everythingBinary], moduleDir);
  await copyFile(join(moduleDir, 'go.mod'), join(output, 'fixture.go.mod'));
  await copyFile(join(moduleDir, 'go.sum'), join(output, 'fixture.go.sum'));
  const expectedFile = join(output, 'expected-warning.yaml');
  await writeFile(expectedFile, 'server:\n  - tools-list:tools-name-format\n');

  for (const [label, checkout] of Object.entries({ baseline, candidate })) {
    await checkedCommand(`${label}-build`, 'npm', ['run', 'build'], checkout, 120000);
    const cases = [
      { name: 'warning-only', warning: true, baseline: false, exit: 0 },
      { name: 'baselined-warning', warning: true, baseline: true, exit: 0 },
      { name: 'clean', warning: false, baseline: false, exit: 0 },
      { name: 'stale-baseline', warning: false, baseline: true, exit: 1 }
    ];
    for (const test of cases) {
      const directory = join(output, label, test.name);
      await mkdir(directory, { recursive: true });
      const observationsPath = join(directory, 'server-observations.jsonl');
      const server = await startServer(fixtureBinary,
        ['-name', test.warning ? 'warning/tool' : 'warning_tool', '-observations', observationsPath], directory);
      const args = ['dist/index.js', 'server', '--url', server.url, '--scenario', 'tools-list',
        '--spec-version', summary.specVersion, '-o', join(directory, 'results')];
      if (test.baseline) args.push('--expected-failures', expectedFile);
      let cli;
      try { cli = await execute(process.execPath, args, checkout, 60000); }
      finally { await stopServer(server); await saveProcess(directory, 'server', server.state); }
      await saveProcess(directory, 'cli', cli);
      const entries = await collectChecks(directory);
      const checks = entries.flatMap(entry => entry.checks);
      const counts = totals(entries);
      const toolNameCheck = checks.find(check => check.id === 'tools-name-format');
      const expectations = {
        expectedExit: cli.exitCode === test.exit,
        finished: !cli.timedOut && cli.signal === null && cli.launchError === null,
        oneScenario: entries.length === 1,
        noFailureChecks: counts.FAILURE === 0,
        expectedNameStatus: toolNameCheck?.status === (test.warning ? 'WARNING' : 'SUCCESS'),
        onlyExpectedWarning: counts.WARNING === (test.warning ? 1 : 0),
        schemaValid: checks.find(check => check.id === 'wire-schema-valid')?.status === 'SUCCESS'
      };
      summary.runs.push({ label, kind: 'single-scenario', case: test.name, exitCode: cli.exitCode,
        counts, checks: entries, observationsPath: relative(output, observationsPath),
        cliPath: relative(output, join(directory, 'cli.stdout.log')) });
      summary.assertions.push({ label, case: test.name, expectations, passed: Object.values(expectations).every(Boolean) });
      await saveSummary();
      console.log(`${label}/${test.name}: exit=${cli.exitCode}, ${JSON.stringify(counts)}`);
    }

    for (const mode of suiteModes) {
      const directory = join(output, label, `active-suite-${mode}`);
      await mkdir(directory, { recursive: true });
      const port = await reservePort();
      const server = await startServer(everythingBinary,
        ['-http', `127.0.0.1:${port}`, `-stateless=${mode === 'stateless'}`], directory, port);
      const args = ['dist/index.js', 'server', '--url', server.url, '--suite', 'active',
        '--spec-version', summary.specVersion, '-o', join(directory, 'results')];
      let cli;
      try { cli = await execute(process.execPath, args, checkout, suiteTimeout); }
      finally { await stopServer(server); await saveProcess(directory, 'server', server.state); }
      await saveProcess(directory, 'cli', cli);
      const entries = await collectChecks(directory);
      const counts = totals(entries);
      const plain = cli.stdout.replace(/\u001b\[[0-9;]*m/g, '');
      const match = plain.match(/^Total: (\d+) passed, (\d+) failed(?:, (\d+) warnings)?\s*$/m);
      const printed = match ? { passed: Number(match[1]), failed: Number(match[2]),
        warnings: match[3] === undefined ? null : Number(match[3]) } : null;
      const expectedExit = counts.FAILURE > 0 || (label === 'candidate' && counts.WARNING > 0) ? 1 : 0;
      const expectations = {
        finished: !cli.timedOut && cli.signal === null && cli.launchError === null,
        retainedScenarioChecks: entries.length > 0,
        printedPassesAgree: printed?.passed === counts.SUCCESS,
        printedFailuresAgree: printed?.failed === counts.FAILURE,
        warningReportingMatchesScope: label === 'candidate' ? printed?.warnings === counts.WARNING : printed?.warnings === null,
        expectedSuiteExit: cli.exitCode === expectedExit
      };
      summary.runs.push({ label, kind: 'active-suite', mode, exitCode: cli.exitCode, counts,
        printed, checks: entries, cliPath: relative(output, join(directory, 'cli.stdout.log')),
        note: 'Counts are observations, not an assumption that the pinned SDK passes this newer conformance checkout.' });
      summary.assertions.push({ label, case: `active-suite-${mode}`, expectations,
        passed: Object.values(expectations).every(Boolean) });
      await saveSummary();
      console.log(`${label}/active-suite-${mode}: exit=${cli.exitCode}, ${JSON.stringify(counts)}, printed=${JSON.stringify(printed)}`);
    }
  }
  summary.allAssertionsPassed = summary.assertions.every(assertion => assertion.passed);
  await saveSummary();
  if (!summary.allAssertionsPassed) process.exitCode = 1;
  console.log(`Full evidence retained in ${output}`);
} catch (error) {
  summary.setupOrExecutionError = String(error?.stack ?? error);
  await saveSummary();
  throw error;
}
