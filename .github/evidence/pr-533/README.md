# MCP #526 / PR #533: session-capacity evidence lab

This lab compares two built conformance CLI checkouts against unchanged SDK
everything-servers. It puts an HTTP proxy on `127.0.0.1` between the CLI and each
fresh server. The proxy admits at most **four issued sessions** for the single
synthetic client represented by that run. A second condition also returns a
fixture-owned JSON-RPC `-32601` for every `prompts/*` request.

The proxy supplies the capacity policy and injected errors. Neither behavior is
claimed to be native SDK behavior. The SDK source and server implementation stay
unchanged, and the existing CLI remains the sole source of conformance verdicts.
The lab observes traffic and checks experimental invariants; it does not select
or execute scenarios itself.

## Preparation and invocation

Provide two conformance checkouts with dependencies already installed. The lab
does not run `npm install` or `npm ci`. It runs `npm run build` in each checkout,
records the exact revision, working-tree patch, source manifest, source hash, and
built output hash, and invokes `node dist/index.js`. Dirty candidate sources are
recorded rather than silently treated as the named commit. Use the optional
revision flags to enforce the expected checkout heads.

For the real comparison, the pre-cleanup baseline is
`7169291ec0b68eb370fddcd9947313ab0d5e4156`. The original PR head was
`a95deff303dc2221654fe4331daf657e0f2ac690`; `644d355d` already contains the first
cleanup implementation and is not an unfixed control. A follow-up candidate can
be supplied without changing this lab.

The TypeScript server is the bundled
`examples/servers/typescript/everything-server.ts` from a **single common
checkout**, defaulting to `--baseline`. Its contents must match that checkout's
HEAD. Its installed `@modelcontextprotocol/sdk` package version and complete
package-file hash manifest are recorded. That one source and dependency tree are
used for both heads and both conditions. The server launches through
`node --import <tsx-package-root-export> everything-server.ts`, using the
installed package's supported import loader. This avoids the `tsx` CLI's unused
IPC listener, which is unavailable in some execution environments. The loader
URL, version, and source hash are recorded. The server uses its existing `PORT`
environment variable; the proxy talks to it on `127.0.0.1`.

For Go, supply an unchanged SDK checkout at exactly
`827f90ba0c13edb546028df42fadc9f1211a4ff2` and an installed Go compiler. The lab
builds `github.com/modelcontextprotocol/go-sdk/conformance/everything-server`
once using a temporary module with a local `replace`. Go build dependencies may
be fetched by the build in CI; the SDK checkout is not edited. The server starts
with `-http 127.0.0.1:PORT -stateless=false`. Go cache and module files live under
the new output directory. `GOTOOLCHAIN=local` prevents automatic toolchain
installation. Node **24.21.0** and Go **1.25.14** are the intended CI runtimes;
actual versions are recorded in every result.

```bash
node /absolute/path/to/lab/run-capacity-evidence.mjs \
  --baseline /absolute/path/to/baseline \
  --candidate /absolute/path/to/candidate \
  --baseline-sha 7169291ec0b68eb370fddcd9947313ab0d5e4156 \
  --candidate-sha CANDIDATE_COMMIT \
  --typescript-source /absolute/path/to/baseline \
  --go-sdk /absolute/path/to/go-sdk \
  --sdk-modes typescript,go \
  --output /absolute/path/to/new-capacity-results
```

For a local TypeScript-only pass, omit `--go-sdk` and set
`--sdk-modes typescript`. The complete matrix has eight runs:

| SDK | CLI checkout | Fixture condition |
| --- | --- | --- |
| TypeScript | baseline, candidate | clean cap 4; reject prompts with cap 4 |
| Go, stateful | baseline, candidate | clean cap 4; reject prompts with cap 4 |

Every cell starts a fresh SDK process and a fresh proxy. There is no
expected-failures file, altered suite, shortened scenario timeout, or custom
conformance runner. Each CLI invocation is:

```bash
node dist/index.js server \
  --url http://127.0.0.1:PROXY_PORT/SDK_ENDPOINT \
  --suite active --spec-version 2025-11-25 --timeout 30000 \
  -o /absolute/path/to/new-capacity-results/SDK/HEAD/CONDITION/results
```

The external whole-CLI watchdog defaults to 600,000 ms and can be changed with
`--suite-watchdog-ms`. It is separate from the CLI's unchanged 30,000 ms
per-scenario timeout. A watchdog expiry is retained as an experimental failure.
It is not converted into a conformance check or a passing result.

## Wire accounting and proxy behavior

A successful upstream initialize response that actually contains
`Mcp-Session-Id` adds that distinct ID to the outstanding-session ledger when its
headers arrive. This timing matters because some existing probes cancel the
initialize response body after reading its headers. A successful upstream
HTTP DELETE releases the requested issued ID. Closing a GET stream, losing a
connection, completing the CLI, and terminating a process never release an ID.
The measurement is **issued IDs without an observed successful DELETE**, not a
measurement of internal SDK memory or open socket count.

In-flight initialize requests reserve admission slots until their upstream
response or transport failure settles, preventing parallel initializations from
bypassing cap 4. A denied initialize receives HTTP 503 with a clearly labelled
fixture error. Prompt injection returns HTTP 200 with a JSON-RPC error whose
code is `-32601`, preserving the request ID. Those requests are recorded as
intercepted and are not sent to the SDK. All other requests reach the SDK.

Finite `application/json` POST bodies are buffered to inspect the top-level
method and ID, then forwarded byte-for-byte. No request-size limit, JSON
rewriting, fake batch support, or extra rejection of malformed probes is added.
Other request bodies stream. All SDK response bodies stream with backpressure,
including SSE; the proxy does not parse or buffer SSE responses. The original
Host and Origin headers are preserved, including deliberately invalid values
from the DNS-rebinding scenario. Only per-connection HTTP framing headers are
regenerated by the proxy.

The JSONL journal records request method, RPC method/ID, session ID, response
status, initialize admission and issuance, successful DELETE release, duplicate
DELETE attempts, GET stream opening/closure, fixture denials, transport errors,
and occupancy snapshots. CLI scenario markers are recorded as attribution
context. Their observation time is not a separate protocol signal. Assertions
about residual origins use initialized client names, requested protocol
versions, and observed RPC methods from HTTP traffic, rather than depending on
relative scheduling between stdout and HTTP events.

Two snapshots are retained before teardown: immediately when the CLI exits and
after a fixed 250 ms allowance for socket-close events already in flight. The
same allowance applies to every cell and cannot remove an outstanding session.
The proxy then closes without sending DELETEs, and the SDK process is stopped.
The journal explicitly marks teardown events so they cannot be mistaken for
successful harness cleanup.

## Assertions fixed before execution

The clean controls must agree in CLI exit code and per-check IDs/statuses across
heads, with zero cap denials. Their outstanding session origins must also agree.
The negative candidate must retain its intentionally failing prompt verdicts,
reach an injected request in every CLI-selected prompt scenario, delete every
actually injected prompt session exactly once, and incur zero cap denials.
Non-prompt check statuses must remain equal to the candidate's clean control.
The negative baseline must demonstrate positive cap denials. Unexpected results
are retained and cause the lab's experimental exit status to fail.

There is one known boundary to the PR's cleanup scope: the current
`dns-rebinding-protection` scenario performs a raw successful initialize and
initialized notification without a DELETE. It bypasses `ctx.connect`. This
scenario is last in the filtered suite, after the prompt scenarios. Its
outstanding session is retained in every ledger where it occurs. The lab
therefore asserts that the candidate's injected-error run adds **no residual
session origins beyond its own clean control**, rather than asserting zero
outstanding sessions for the entire suite. At the first actual `prompts/*`
request, it also requires no outstanding session other than that request's own
session and no pending initialize, establishing that an earlier leak did not
cause the baseline's prompt exhaustion. The lab does not modify the DNS
scenario or forgive unexpected residuals after looking at a run.

If capacity blocks a baseline DNS probe, the resulting 503 is identified as
fixture-generated. Such a downstream conformance failure is evidence of
capacity-induced contamination, not evidence of an SDK DNS-validation defect.

Other invariants require actual stateful session issuance, no session-ID reuse,
capacity never exceeding four, no unresolved initialize admissions, complete
per-scenario check artifacts, agreement between printed CLI totals and saved
checks, and no unexpected proxy failures. The SDKs are not assumed to satisfy
the newer conformance checkout: any additional SDK failure remains visible and
can make an asserted expectation fail.

## Evidence artifacts and failure handling

`summary.json` contains provenance, each run's unchanged CLI verdict, all saved
checks, ledger snapshots, comparisons, and each experimental assertion.
`SDK/HEAD/CONDITION/run-summary.json` is the per-cell copy. Each cell also retains
the complete CLI and SDK stdout/stderr, exact invocations and exit codes,
`http-events.jsonl`, and the existing CLI's whole `results/` directory. Build,
revision, patch, dependency, Go module, and binary metadata logs are retained at
the top level. Copies of this lab's sources accompany the evidence.

The output directory must be new. Setup failures, malformed/missing result
files, SDK startup failures, and watchdog termination are written into the
summary instead of being replaced with expected counts. A failing cell does not
prevent the remaining prepared cells from running. The final lab exit code is
nonzero if any experimental assertion or setup step fails; that exit code is
distinct from each retained conformance CLI exit code.

For CI, upload the full output directory with an `if: always()` artifact step,
excluding only `build-work/` caches and binaries if desired. Use a job timeout
long enough for builds plus all eight cells. Keep the checkout and artifact
workflow under the reviewing contributor's control; this script performs no
pushes, comments, uploads, live-service operations, or authentication setup.
