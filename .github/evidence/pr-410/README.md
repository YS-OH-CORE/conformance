# Prepared Go SDK evidence for MCP conformance PR #410

**Preparation status: not executed.** The local workspace has no Go executable. These files are prepared for a Go-enabled CI job; they are not build, test, or conformance results.

This evidence preserves [maxisbey's original PR #410 scope](https://github.com/modelcontextprotocol/conformance/pull/410): its server suite summary counts warnings and its unbaselined suite exit reflects warnings. The original change does **not** update the single-scenario exit branch. The controls below explicitly preserve and document that remaining gap.

## Exact inputs

- Conformance baseline: `7169291ec0b68eb370fddcd9947313ab0d5e4156`.
- Candidate: faithful rebased PR commit `eac19c4499ebb37ea359024be9aa4cd5c401c154` in `YS-OH-CORE/conformance`, passed with `--candidate`; its actual commit is recorded at execution time.
- Go SDK: **`827f90ba0c13edb546028df42fadc9f1211a4ff2`**, resolving the author's cited `827f90b`.
- SDK module requires **Go 1.25.0**. Use Go 1.25 or later; the script records the actual toolchain and binary build metadata.
- Protocol mode: **2025-11-25**.

The script refuses the wrong baseline or SDK commit and refuses tracked modifications in the SDK checkout. It resolves the Go SDK through a module replacement to that verified local checkout, without editing the SDK. Generated module files, caches, and binaries live beneath the evidence output's `build-work/` directory.

## Four real-SDK single-scenario controls

`go-fixture/main.go` constructs a real `mcp.Server` and serves it with the real `mcp.NewStreamableHTTPHandler`. The fixture registers one tool using the SDK's public API. It neither synthesizes protocol responses nor modifies SDK response bytes.

At the pinned revision, `Server.AddTool` logs an invalid tool name but still registers it. The intentionally invalid application-level name `warning/tool` therefore supplies a natural SHOULD violation while the SDK constructs the response. The clean control uses `warning_tool`. Both have a description and an object input schema.

The existing built CLI runs `server --scenario tools-list --spec-version 2025-11-25`. It alone selects the scenario, creates checks, prints results, and calculates its exit code.

| Control | Tool name | Expected-failures file | Expected baseline exit | Expected faithful candidate exit |
| --- | --- | --- | ---: | ---: |
| Warning only | `warning/tool` | None | **0** | **0** |
| Baselined warning | `warning/tool` | Matching check | 0 | 0 |
| Clean | `warning_tool` | None | 0 | 0 |
| Stale baseline | `warning_tool` | Matching check | 1 | 1 |

The matching baseline is generated as:

```yaml
server:
  - tools-list:tools-name-format
```

The warning-only exit of 0 on **both** revisions is intentional evidence of the residual single-scenario gap, not an assertion that #410 fixes it. Expected check-level invariants are `tools-name-format: WARNING` only for the two invalid-name controls, zero FAILURE checks, and `wire-schema-valid: SUCCESS` in every control. Actual HTTP requests and responses are retained as JSONL, alongside full CLI and Go server logs.

## Existing Go conformance server through the actual suite CLI

The script separately builds the pinned SDK's **unmodified** `conformance/everything-server` package and runs:

```sh
go-everything-server -http 127.0.0.1:PORT -stateless=false
node dist/index.js server --url http://127.0.0.1:PORT \
  --suite active --spec-version 2025-11-25 -o RESULTS
```

The Go fixture's default is `-stateless=true`. The stateful override matters for this dated suite: sampling and elicitation need server-to-client requests, while resource subscriptions and multiple-stream checks need sessions. The source contains the dated content, sampling, elicitation, resource, prompt, and completion fixtures; no source-level reason to increase the existing 30-second scenario timeout was identified.

The script does **not** assume this older SDK passes every scenario in the newer conformance checkout. It retains every actual `checks.json`, sums SUCCESS/FAILURE/WARNING statuses, and compares those counts with the CLI's printed suite total. It also checks the faithful exit rules:

- Baseline suite: fail on FAILURE checks; WARNING checks are omitted from the summary and do not alone change the exit.
- Candidate suite: report the observed warning total; fail on FAILURE or WARNING checks.

A suite can therefore contain real SDK failures and still provide valid evidence that the CLI summary and exit policy reflect the recorded checks. The summary explicitly retains these failures; they must not be described as a green conformance suite.

If the stateful suite produces no warnings and additional warning-bearing suite evidence is needed, rerun with `--suite-modes stateful,stateless`. This runs the same unmodified SDK in its existing stateless mode as an explicitly labeled negative configuration control. In that mode `server-sse-multiple-streams` naturally emits `server-sse-multiple-streams-session: WARNING` because initialization has no session ID; sampling/elicitation failures are also expected. Counts remain measured, not hardcoded. No synthetic wire mutation is needed. The default runs only the minimal stateful suite comparison.

## CI execution

Prepare Node dependencies in both conformance checkouts with the repository's normal `npm ci` workflow. Check out the Go SDK at the exact commit above and install Go 1.25 or later. No public server, account, or credentials are needed for the tests; dependency acquisition requires normal Go/npm network access.

```sh
node run-go-evidence.mjs \
  --baseline /path/to/conformance-baseline \
  --candidate /path/to/conformance-candidate \
  --sdk /path/to/pinned-go-sdk \
  --output /path/to/new-evidence-directory
```

For the requested CI comparison of both existing SDK modes, add `--suite-modes stateful,stateless`. This produces eight single-scenario controls and four full suite runs across the two conformance revisions.

The output directory must not already exist. The script builds both existing CLI checkouts with `npm run build`, builds the two Go servers, and executes eight single-scenario runs plus one suite run per revision. It does not add a new conformance runner or edit conformance source, scenarios, requirement sets, or SDK source.

Each full suite has a separate ten-minute orchestration watchdog. The existing CLI's per-scenario timeout stays at its 30-second default. If necessary, `--suite-timeout-ms` changes only that outer watchdog; timeouts are retained as failures, not silently retried. Give a CI job sufficient time for initial dependency downloads, builds, and both suites.

The Go fixture binds port 0 directly and reports its selected loopback URL. The unmodified SDK server accepts a port but does not publish the resolved port for port 0, so orchestration chooses an unused ephemeral port, starts the server, and verifies its listener before launching the CLI. There is a small ordinary bind race in that latter step; readiness failure stops the run and preserves server logs rather than silently retrying or hiding it.

## Retained output

- `summary.json`: actual runtime, exact source revisions and SDK module hashes, all observed check counts, printed suite totals, and assertion outcomes. A setup failure is recorded separately and cannot become a successful run.
- Root `*.stdout.log`, `*.stderr.log`, and `*.invocation.json`: complete revision checks, builds, Go module resolution, and binary metadata commands.
- `fixture.go.mod` and `fixture.go.sum`: generated Go module dependency record after both builds.
- `expected-warning.yaml`: the exact baseline used by the controls.
- `<baseline|candidate>/<case>/cli.*`: full CLI stdout, stderr, command, exit code, signal, and timeout status.
- `<baseline|candidate>/<case>/server.*`: full SDK-server stdout, stderr, and process metadata.
- `<baseline|candidate>/<single-case>/server-observations.jsonl`: actual HTTP requests and SDK-produced responses.
- `<baseline|candidate>/<case>/results/*/checks.json`: unmodified output from the existing CLI.

**Do not upload `build-work/` as evidence.** It contains potentially large module/build caches and binaries. Retain all other output, including failed runs, stderr, and partial results if setup or a watchdog fails. SDK suite runs use the unmodified server, so their evidence is the real CLI checks and full server logs; HTTP-body recording applies to the minimal single-scenario fixture only.

Primary source references: [pinned Go module](https://github.com/modelcontextprotocol/go-sdk/blob/827f90ba0c13edb546028df42fadc9f1211a4ff2/go.mod), [tool registration behavior](https://github.com/modelcontextprotocol/go-sdk/blob/827f90ba0c13edb546028df42fadc9f1211a4ff2/mcp/server.go#L273), [SDK Streamable HTTP examples](https://github.com/modelcontextprotocol/go-sdk/blob/827f90ba0c13edb546028df42fadc9f1211a4ff2/mcp/streamable_example_test.go), and [unmodified conformance server](https://github.com/modelcontextprotocol/go-sdk/blob/827f90ba0c13edb546028df42fadc9f1211a4ff2/conformance/everything-server/main.go#L31).
