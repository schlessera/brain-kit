# Host-owned web search research (#1969)

This is a manually invoked, keyless research harness, outside production and the
automatic test inventory. The [comparison](../../docs/plans/host-owned-web-search.md)
distinguishes source support, measured plain search and unqualified integration.
It must not be used as a credentialed service or production RPC implementation.

## Prepare once, with registry access

From an installed brain-kit checkout, choose new absolute temporary paths outside
the repository. Neither command reads a real Pi configuration or login. Python
3.12+ is needed for safe tar extraction. Bun, Node >=22.19.0, bwrap, Python,
user/network namespaces and the repository's worker prerequisites are required.
The receipt used Bun 1.4.3, Node 26.7.0 and Linux x86-64.

```sh
python3 experiments/host-web-search/artifacts.py /var/tmp/odysseus-search-artifacts
mkdir /var/tmp/odysseus-search-install
cp experiments/host-web-search/fixture-install/{package.json,bun.lock} /var/tmp/odysseus-search-install/
bun install --cwd /var/tmp/odysseus-search-install --frozen-lockfile --ignore-scripts --backend=copyfile
```

The artifact command verifies registry SHA-512 and recorded tarball SHA-256 for
both baseline 0.27.0 and candidate 0.41.0. The frozen research install reuses the
published compiled entry points and pins all Pi SDK packages to 0.99.2. It does
not install a package into the workspace or change root dependency resolution.
Keep the metadata and source extraction for auditing the report's upstream line
references. The install's pi-web-access tarball integrity also appears in the
fixture lock. No npx, boot-time install or moving upstream main is used.

## Run offline

```sh
SEARCH_RESEARCH_INSTALL=/var/tmp/odysseus-search-install bash experiments/host-web-search/run.sh mcp
SEARCH_RESEARCH_INSTALL=/var/tmp/odysseus-search-install bash experiments/host-web-search/run.sh full
```

Both commands must exit 0. They unset inherited environment credentials and use
an outer bwrap network namespace, loopback-only inference/provider servers and
the existing child network preload. Node MCP is not instrumented by that Bun
preload: its explicitly offline outer namespace is the boundary. No real curl,
provider, login or browser requests are needed. The SearXNG request carries only
a fictional header sentinel and returns fictional Odysseus text. Provider URLs
and credential fields are fixed in the host, outside worker visibility.

`prepare.ts` derives a temporary fixture from the existing real ordinary Pi
worker probe. It installs a denial probe and drives existing `query_activity`
permission/RPC forwarding as a research carrier; it does not propose changing
that tool or bypass production RPC grants. A second real concurrent worker
replays the first worker's upstream ID against its own executor; no worker
selects the executor identity. The first Pi session resumes on a fresh worker.
Each executor has a separate state/cache directory and process. Full mode uses
the actual SDK session and actual published extension; no fake ExtensionContext
is used. It drives tool execution through fictional inference, whose cost
estimates are not paid cost observations.

Named assertions cover worker forwarding/result delivery, a real provider call,
header sentinel, private-path denial, own-result retrieval, foreign-worker replay
denial, unchanged host/parent configuration, restart result loss, worker exit and
two real session identities. Full child and MCP child exits must be 0; MCP transport closure
is awaited. The pinned MCP client child is observed through its internal process
field for research-only exit evidence. Startup milliseconds are single samples, not a benchmark. A 60-second outer command watchdog bounds a broken research invocation; it does
not qualify per-call cancellation, executor death or service limits.

The shell trap removes only its owned temporary tree and generated fixture.
Do not run two invocations against the same checkout concurrently: generation
uses exclusive creation. Existing fixture/starting checkout files are not reset.
On early initialization failure, retain stderr before interpreting downstream
assertions; a module-load failure is not a forwarding receipt.

## Runtime mutation

Save `host.ts` outside the tree. In `runSearch`, replace only the returned
`{ researchResult: result }` with `{ researchResult: "forwarding removed" }`.
Run MCP again. Expected exit: 1 at **WORKER_RECEIVED_HOST_RESULT**, after the
actual worker, provider and own/foreign controls run. Restore the saved file and
rerun both modes. Do not count schema errors, missing fixture auth, process
startup failures or later cleanup errors as that receipt.

For production implementation, separately mutate credential denial and
session/turn authorization, then qualify all four tools, restricted/governed
profiles, cancellation, revocation, lifecycle, byte/concurrency limits and egress
under their real boundaries. This research only proves the named bounded cases.

## Update discipline

An upstream update needs a new issue/ruling, exact registry/tarball integrity,
source review and an isolated lock refresh. Compare enabled/renamed tool schemas,
error and structured-result shapes, provider/auth/fallback order, endpoint/header
and redirect policy, model/SDK peers, process/runtime requirements, result/cache
and session semantics. Repeat worker and isolation mutations plus lifecycle and
negative authority proof before any production dependency changes. The upstream
MCP executable is documented; `web-tool-core.ts` deep imports are not a promised
stable embedding API. Request such an API before committing to its maintenance.
