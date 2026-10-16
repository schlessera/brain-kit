# Host-owned web search: executor comparison

Research for [#1969](https://github.com/schlessera/brain-kit/issues/1969),
2026-10-15, informing [#1863](https://github.com/schlessera/brain-kit/issues/1863).
The maintainer selected host-owned configuration, credentials and execution
(C). **The executor remains a maintainer choice.** No production integration,
dependency upgrade, provider parity or deployment is approved by this report.

## Artifact and runtime identity

Both registry tarballs were fetched by version and checked against their registry
SHA-512 integrity before extraction. SHA-256 identities:

| Artifact | gitHead | Tarball SHA-256 |
| --- | --- | --- |
| [pi-web-access 0.27.0](https://registry.npmjs.org/pi-web-access/0.27.0) | `8f11a0a94988093b0ea5d725d18e8dcabacd2373` | `402fea298e6e38e5da9b302307599ebc5ded30a14e6a637c1410161add17315a` |
| [pi-web-access 0.41.0](https://registry.npmjs.org/pi-web-access/0.41.0) | `d47dc040552505e3b135d0136a0b15eaf4bdba52` | `68c4eb20216fe77fe69b0fcdb24e03c0cc6e0c7cc7bad8e88b47373da1c91aec` |

The comparison below concerns **0.41.0 on both sides**. 0.27.0 has no MCP
executable or package exports map; its earlier real-provider worker reproduction
is retained on #1863, with its original revisions and limitations. That receipt
is not evidence about the new executors. This spike does not rerun that historical
comparison or assert a breaking change from a missing configuration file alone.

Prototype brain-kit base: `200efc8d4e5e2ef6bd7c5385440a9289bd14c774`.
Linux x86-64; outer/worker/full-extension runtime Bun **1.4.3**; MCP runtime
Node **26.7.0**. Actual fixture-loaded Pi coding-agent, agent-core, ai and tui
are **0.99.2**, typebox **1.1.38**. The research install is separate from the
workspace; its complete transitive identities/integrities are frozen in
[the fixture lock](../../experiments/host-web-search/fixture-install/bun.lock).
The workspace SDK pins and root lock are unchanged.

0.41.0 declares Node >=22.19.0. Its dev/test Pi identity is 1.0.4 with typebox
1.3.27; its Pi peer ranges are `*` (Pi peers optional, typebox required).
Dependencies include MCP SDK 1.32.1, undici ^8.11.2, defuddle 0.19.3,
readability ^0.6.0, linkedom ^0.16.0 and unpdf ^1.6.2. These declarations
are not a compatibility receipt for brain-kit's older SDK. A real search
succeeded on the measured 0.99.2 pair, but other extension features remain
unqualified. #1898 selects a project-wide Bun >=1.4.2 support policy; its
manifest implementation is separate. Node's upstream floor neither establishes
Bun compatibility nor authorizes raising Pi pins.

Source pointers below refer to files **inside the integrity-checked 0.41.0
tarball**, not moving upstream main. Principal anchors: [mcp-cli.ts, lines 1-40](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/mcp-cli.ts),
[mcp-server.ts, lines 25-71](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/mcp-server.ts), [web-tool-core.ts, lines 510-556,1452-1548](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/web-tool-core.ts),
[index.ts, lines 736-878,1387-1405,1436-1692,1950-1980,2163-2175,2269-2686](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/index.ts),
[gemini-search.ts, lines 538-738](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/gemini-search.ts), and [storage.ts, lines 74-84,521-550](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/storage.ts).

## Feature and authentication matrix

**Supported** means an upstream source implementation exists in that candidate;
it does not mean a live provider was qualified. **Unavailable** means an explicit
omission or no applicable upstream auth mode. **Adapter required** means the
feature needs additional trusted authority/lifecycle/UI integration in our host.
**Unverified** means the runtime claim has not been demonstrated. Only fictional
loopback SearXNG search/retrieval was exercised; every real catalog provider and
login/browser mode below is runtime **unverified**.

The curated catalog is the ten providers in (`WEB_SEARCH_PROVIDERS`,
`packages/ui-sdk/src/server/web-search.ts:52-153`), rather than every provider
upstream happens to support.

| Curated provider / auth mode | MCP | Full extension | Source and qualification limit |
| --- | --- | --- | --- |
| Exa, keyless | Supported | Supported | `exa.ts`, `isExaAvailable` and no-key MCP path; keyless service availability unverified |
| Exa, API key | Supported | Supported | `exa.ts`, credential resolver and API path; unverified |
| DuckDuckGo, keyless | Supported | Supported | `duckduckgo.ts`, availability/search; unverified |
| DuckDuckGo, API key | Unavailable | Unavailable | No provider API-key mode in this implementation |
| Brave, API key; keyless | Supported; unavailable | Supported; unavailable | `brave.ts`, `requireApiKey` / `searchWithBrave`; unverified |
| Jina search, API key; keyless | Supported; unavailable | Supported; unavailable | `jina-search.ts`, `isJinaSearchAvailable` / `requireApiKey`; reader fallbacks are a different capability |
| Perplexity, API key; keyless | Supported; unavailable | Supported; unavailable | `perplexity.ts`, key availability and search; no Pi subscription fallback claimed |
| Tavily, API key; keyless | Supported; unavailable | Supported; unavailable | `tavily.ts`, credential pool/fallback and `tavilyRequest`; unverified |
| OpenAI, explicit API key | Supported | Supported | `openai-search.ts`, `resolveOpenAIAuth`; custom destinations require the configured Responses endpoint |
| OpenAI, Pi ChatGPT/Codex sign-in | Unavailable | Adapter required | [openai-search.ts, lines 281-345](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/openai-search.ts) needs real model registry, resolved key/headers/base URL; standalone rejection in [web-tool-core.ts, lines 1452-1479](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/web-tool-core.ts) |
| OpenAI, current Pi model/provider base URL | Unavailable | Adapter required | `resolvePiAuth`, `openaiUseProviderBaseUrl`, current-model routing; credentials must stay in the trusted executor |
| OpenAI, unauthenticated keyless | Unavailable | Unavailable | A subscription login is credentialed, not anonymous/keyless |
| Gemini, API key | Supported | Supported | `gemini-api.ts`, [gemini-search.ts, lines 739-789](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/gemini-search.ts); unverified |
| Gemini, ADC / gateway credentials | Supported | Supported | `gemini-api.ts`, versioned endpoint/ADC routing; authority and real auth unverified |
| Gemini, browser-cookie login | Adapter required | Adapter required | `gemini-web.ts`, `chrome-cookies.ts`, [gemini-web-config.ts, lines 80-112](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/gemini-web-config.ts); reachable from shared search code, so MCP is not inherently browser-free |
| Gemini, anonymous keyless | Unavailable | Unavailable | Cookie/ADC modes still require credentials |
| Firecrawl, API key | Supported | Supported | `firecrawl.ts`, configured base URL/request; unverified |
| Firecrawl, self-hosted no key | Supported | Supported | Configured base URL can use no API key; this is not free public-service access; unverified |
| Kagi, API key; keyless | Supported; unavailable | Supported; unavailable | `kagi.ts`, `requireApiKey` / search; unverified |
| Kimi login (outside curated catalog) | Unavailable | Adapter required | [kimi-search.ts, lines 37-65](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/kimi-search.ts) resolves Pi kimi-coding model auth/headers; MCP rejects it explicitly |

API credentials can be literal, environment-backed or command-resolved according
to upstream credential resolution. **Command-resolved credentials require a
separate authority decision**: accepting arbitrary credential commands in a
host-owned config would grant host execution. Browser-cookie mode similarly needs
an explicit narrow credential broker/export decision; mounting host HOME, browser
profiles or keyrings is not an acceptable implicit adapter. No cookie/login
probe was run.

Both candidates retain provider-specific endpoint behavior. Examples are
`exaBaseUrl`, `braveBaseUrl`, `tavilyBaseUrl`, `firecrawlBaseUrl`,
`geminiBaseUrl` and `openaiResponsesUrl`; SearXNG also has configured headers.
There is no universal endpoint/header override contract. Pi-resolved OpenAI
headers/base URLs have additional checks before credential reuse. Worker inputs
must not expose these fields. The prototype exercises only SearXNG's host-owned
base URL and fictional header; general endpoint/header and redirect compatibility
remain unverified.

| Feature | MCP | Full extension | Consequence for our adapter |
| --- | --- | --- | --- |
| `web_search` plain search | Supported | Supported | Real loopback search passes for both |
| `fetch_content` readable/raw | Supported | Supported | Extraction/fallback network and subprocess paths need qualification |
| `get_search_content` | Supported | Supported | Real own-session retrieval and foreign-worker replay denial pass with separate processes |
| `source_check` | Supported | Supported | Shared research/artifact pipeline; runtime unverified |
| Curator / summary-review | Unavailable | Adapter required | Real UI/browser server, approval, lifetime and trusted model callbacks needed |
| Auto-summary | Unavailable | Adapter required | Model registry/auth, model scope, nested completion usage and cancellation needed |
| `fetch_content` answer mode | Unavailable | Adapter required | `answerFromPage` requires actual ExtensionContext/model access |
| Image fetch, video prompts/frames and YouTube model processing | Unavailable for documented Pi-only modes | Adapter required | Binary limits, model auth, subprocess/cache and data-routing proof needed |
| `includeContent` | Supported, blocking | Supported, background for ordinary calls | Pi host publishes result and notification; nested calls await unless summary-review requests background |
| Notifications / partial tool updates | Unavailable as Pi notifications/updates | Adapter required | `sendMessage`, `onUpdate`, widget/UI semantics and turn-trigger admission cannot be copied blindly |
| Tool renames / enable flags | Default names only; enable flags supported | Supported | Host must map approved worker names once and prevent duplicate direct extension registrations |
| Text / structured results / errors | Text content and `isError`; host details deliberately omitted | Text, structuredContent and details | Normalize intentionally; do not invent MCP structured parity or infer success only from transport success |
| Persistence / resume / forks | 50 recent in-memory results; restart loses them | Session custom entries plus disk fetch cache | Trusted per-session restore and explicit fork policy required; startup alone is not restore |
| Extension commands / shortcuts / nested tools | Unavailable | Adapter required | `/websearch`, `/curator`, `/search`, `/google-account`, shortcuts and nested tool entry points can bypass a naive four-tool wrapper |

MCP's schema does **not** accept a `workflow` call argument. The initial probe
attempt returned an invalid-arguments tool error before provider execution;
removing that extension-only parameter fixed the harness. Configured workflows
are ignored by the standalone host. `mcp-server.ts` strips host `details` and
maps invalid inputs/provider failures into tool errors. Full extension results
in the real probe included structured search data and details, while MCP
returned text. These differences are measured, not inferred from shared names.

Provider order is shared implementation, not our catalog's UI cost ranking.
[gemini-search.ts, lines 623-738](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/gemini-search.ts) implements configured ordered routes with classified
fallback conditions; explicit provider overrides, arrays and `all` follow their
own paths. Arrays/`all` fan out concurrently (`searchWithProviders`); automatic
routing may attempt several providers, including after empty successful results.
Pi context changes OpenAI availability/order, so identical JSON configuration
need not produce identical provider selection across standalone and extension.
Queries, includeContent, extraction fallbacks, source_check, summaries, rewrites
and video analysis can multiply paid calls. A single bridge request is not a
single priced provider call.

## Full-extension authority map

A full external extension executor needs an **actual trusted Pi session**, not a
cast object shaped like ExtensionContext. The prototype constructs one with the
installed SDK, an empty host-owned cwd/agent directory, the one pinned upstream
extension, no built-in tools and fictional inference. It does not load the
brain's extensions, context files, settings, hooks, models or scripts in this
credentialed process. That must remain true in production.

| Dependency | Why the extension uses it | Permitted boundary / unresolved choice |
| --- | --- | --- |
| `model`, `modelRegistry`, scoped models | OpenAI/Kimi login, current model, answer, summaries, rewrites, media | Host-resolved model identity and narrow auth service; decide permitted nested models/providers and budget admission |
| Real SDK session manager / branch | Session-start/tree restoration, custom result entries, model context | Host-owned per-session state; no raw brain transcript/config import without explicit sanitized data boundary |
| `appendEntry`, result/cache storage | Persist search/fetched text and IDs; restore/cache pruning | Private per-session directory, quotas/TTL, authorized handles and deletion; never authoritative `brain.db` state |
| `sendMessage`, notifications, widgets, `onUpdate` | Content-ready events, partial search/curator progress | Translate to existing user/turn events; no unrestricted new model turn or fake hasUI parity |
| UI select/notify, commands, shortcuts | Account selection, stored results, curator settings | Dedicated host controls or explicitly unavailable; worker cannot invoke arbitrary extension commands |
| Curator server / browser launch | Review, summary approval and query rewriting | Authenticated session-scoped UI route and bounded lifetime; no arbitrary host browser/shell authority |
| Extraction subprocesses / clone cache | GitHub, PDFs/video, browser/curl or other extraction paths | Pinned executable roster, no private repository login by default, isolated files and restricted egress |
| Browser profile/keyring / credential commands | Optional login-dependent inputs | Additional explicit authority choice or disclose unavailable; never host HOME exposure |

A shared-core adapter can call `createWebToolCore` and supply
`WebToolCoreHost` callbacks ([web-tool-core.ts, lines 510-556](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/web-tool-core.ts)). It avoids recreating
provider clients. It does **not** include index.ts's curator, session events,
summary workflow, nested-call semantics, commands or UI. Preserving them means
owning explicit equivalents and their regression tests. Both core and
`createMcpServer` are packed implementation files without a package exports map
or documented embedding stability promise. Prefer an upstream embedding API
request before relying on deep imports; obtaining it is not assumed or a
prerequisite for recording this spike's result. No upstream message was sent.

## Common bridge and governance design

These are proposed implementation requirements for #1863, not newly approved
runtime authority or a public plugin seam. Both candidates need them:

1. The server binds every executor call to the admitted principal, session,
   turn, tool-call grant, profile, policy revision and cancellation signal.
   Worker fields cannot choose those identities. Revalidate liveness before
   dispatch and before returning data. Treat retrieval as an authorized call.
2. Resolve a server-owned provider/endpoint/credential profile. Validate tool
   parameters against a narrow schema; reject unknown fields, arbitrary proxy,
   command, local path and endpoint selection. Validate an explicit provider
   against the admitted subset, including arrays, `all`, fallbacks and nested
   model calls. Disable credential commands and browser discovery unless a
   separate choice supplies a bounded trusted adapter.
3. Route executor networking through a **mandatory** server-owned egress route,
   with DNS/IP/port and every redirect checked, private/link-local/metadata and
   non-HTTP destinations refused, bounded response bytes and no credential
   forwarding across unapproved origins. Apply this to provider APIs as well
   as extracted URLs. Upstream extraction SSRF guards and credential-stripping
   redirects are useful but are not proof of this whole policy. Upstream
   `utils.ts` proxy support can spawn curl and honors bypass settings; passing
   proxy variables alone does not establish containment. No TLS interception.
4. Authorize prompt/content routing before each provider and nested model call;
   record external content as untrusted and taint the session. Reuse permission,
   data-routing, attribution, outward-action and existing budget admission.
   Unknown external price/usage stays unknown. Until all call paths are metered,
   disclose the coverage gap and enforce actual available request/token/resource
   bounds; do not claim a complete USD stop from centralized execution.
5. Keep result/cache state scoped to session and principal. Map opaque external
   handles on the server, never trust an upstream ID as authorization. A
   separate process and cache directory per session is the simplest candidate;
   a central config service does not require a shared result store. Reject
   guessed/replayed handles across sessions/forks, bound stored bytes/TTL and
   define resume/restart/config-revision invalidation before pooling.
6. Set explicit request/response bytes, query/URL counts, provider/model fan-out,
   per-session and global concurrency, pending-queue length, call/turn deadlines
   and cache quotas. Reserve capacity before any paid dispatch. Numerical limits
   need the implementation's workload/proof; this report does not invent an
   approved policy. Cancel pending calls, kill/drain owned process groups on
   death/deadline, settle promises, erase ephemeral state and retain truthful
   terminal receipts. No process leak or late cross-turn background result.
7. Register only the server forwarding roster in ordinary governed/strict
   workers; do not also load direct upstream search tools or expose nested or
   command bypasses. Keep restricted autonomous turns without this capability
   unless separately authorized. Main currently loads prepared extensions;
   that remains a production migration concern, not solved by this experiment.

Current source confirms why a bridge is needed: ordinary initialization copies
only auth/models/settings (`const init`,
`packages/ui-backend-pi/src/worker-session.ts:114-116`), then selects private Pi
state. The worker RPC schema has an existing bounded, grant-checked bridge but
no search method (`export const piWorkerMessage`,
`packages/ui-backend-pi/src/worker-protocol.ts:64-70`). Resource discovery remains
worker-local (`export function createSessionResources`,
`packages/ui-backend-pi/src/session-resources.ts:29-46`). A new production
search RPC/tool contract requires its own review; the experiment's activity
carrier is not a proposed API.

Pooling is not equivalent to constructing a core per session. Upstream
[storage.ts, lines 70,434](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/storage.ts) keeps results in a module-global map and
[web-tool-core.ts, lines 1148](https://github.com/nicobailon/pi-web-access/blob/d47dc040552505e3b135d0136a0b15eaf4bdba52/web-tool-core.ts) retrieves by upstream ID, without our principal/turn
context. The extension's per-instance held-result sets manage lifetime, not
server authorization. A pool would need an independently enforced host handle
ownership map, isolated cache namespaces, cancellation/config-revision leases
and evidence that releasing one session cannot affect another. No shared-process
pool was qualified. Process-per-session costs a separate Node MCP process or
Pi SDK runtime; a bounded idle lifetime plus explicit restore policy is a
candidate tradeoff, not approval to share results.

## Offline prototypes and what they prove

[The research harness](../../experiments/host-web-search/README.md) retains exact
commands, isolated dependency installation, fictional fixture, named assertions
and mutation procedure. It derives a temporary copy of the existing real-worker
fixture and routes a fixed search through **the actual permission/bridge RPC**.
`query_activity` is used only as an experimental transport carrier; no production
activity behavior is changed. Its host callback calls either the actual Node
MCP executable or a real SDK session loading the actual published full extension.
Neither uses a rewritten provider client or fabricated ExtensionContext.

Two actual ordinary strict Pi sessions overlap. Ithaca's worker requests the
search; Troy's worker submits the returned upstream handle through its own
host callback. Each host callback is closed over its own executor, not a
worker-selected session. Troy cannot retrieve Ithaca's result; Ithaca can.
The worker's separate probe cannot read host configuration or the fictional
credential/header sentinel. The loopback provider checks that sentinel arrived
from the host. Parent auth/models/settings and host web-search config bytes
remain unchanged; the final real-worker receipt reports no remaining worker
PID. Pi resume succeeds with its history retained. Executors close; fresh
executors without restored SDK entries cannot recover the old handles.

Measured successful development receipts (single samples; no performance claim):

| Candidate | Forwarding / replay | Provider calls | Two executor startups |
| --- | --- | --- | --- |
| Node MCP | Actual worker gets fictional Athena result; concurrent foreign-worker replay denied | 2 (bridge search and own-result control) | 281.18ms / 256.56ms |
| Bun full extension, real Pi 0.99.2 context | Same worker/result/denial proof; restart loss asserted | 2 | 913.22ms / 863.31ms |

Each outer harness exits 0. The retained runner also requires actual full and
MCP executor child exits of 0; the latter uses a research-only observation of
the pinned client transport process. The earlier nonconcurrent development control also
passed for both candidates. MCP transport calls do not incur a model turn; the
full-extension prototype intentionally drives a real SDK tool call through
fictional inference, so its measured overhead includes that harness choice.
Tarballs are 6,583,318 bytes (0.27.0) and 7,102,345 bytes (0.41.0); extracted
0.41.0 package occupies 10,163,972 apparent bytes in this extraction. These are
artifact measurements, not installed transitive footprint, memory or throughput.
No cancellation latency, process RSS, contention or production startup benchmark
was measured.

Removing the returned host search data while leaving real provider calls intact
makes the real worker probe exit 1 at `WORKER_RECEIVED_HOST_RESULT`. Restoring
forwarding restores the pass. This is a runtime forwarding mutation; initial
schema/auth harness setup failures are not regression receipts.

**Unqualified lifecycle/authority proof required for implementation:** all four
tools end to end; simultaneous bidirectional worker replay/guessed IDs and cache
file attempts for both governed and strict; durable resume/fork ownership and
entry restoration; changed config/credential revision restart; in-flight and
queued cancellation, deadline, crash/kill and stalled executor; malformed or
oversized protocol, response/output floods and concurrency admission; cleanup
under those failures; direct-network/extension-command/nested-call bypasses;
restricted-turn denial; SSRF/redirect/proxy and nested provider/model routing;
permission revocation, taint and truthful budget accounting. The prototype
processes are isolated by directory/process but are **not** a qualified credentialed
service sandbox. Its finite happy-path run and process cleanup are not evidence
that cancellation, egress or arbitrary-input bounds have passed. Native Btrfs
storage qualification is also outside this copied startup-view fixture.

Live credentials/browser/login/paid calls were neither used nor authorized.
Their proof plan is an explicitly authorized isolated account/configuration,
one named provider/auth mode at a time, exact runtime/artifact identity,
credential non-disclosure, request routing and measured usage/unknown-cost
receipts, with rollback/cleanup. A source-supported mode stays runtime
unverified until that evidence exists; production acceptance may instead
explicitly exclude it after a maintainer ruling.

## Options to return to the maintainer

| Choice | Benefits | Loss / maintenance / authority cost |
| --- | --- | --- |
| A: upstream MCP process per session | Published executable/protocol; upstream owns standalone schemas and provider code; no Pi session required | Explicit loss of Pi-only modes above; text/error mapping, blocking includeContent, volatile handles and separate Node runtime; still requires egress/auth/budget isolation |
| B: trusted full extension in a real Pi session per session | Reuses actual extension workflows and login/model implementation; offline plain search works with current pins | Largest trusted surface; real model/auth/session/UI adapters and command/nested-call containment; no full parity qualification; process and model-harness overhead |
| C: shared-core adapter with explicit feature subset | Reuses provider/extraction core; precise host-owned storage and callbacks | Internal/deep imports; must own missing workflows and compatibility obligations; cannot be advertised as full extension; seek upstream embedding API |
| D: none meets required authority/parity limits yet | Preserves boundary without silently dropping auth/features | Defer production integration and request upstream changes or a narrower explicitly approved product scope |

**Recommendation:** if subscription/current-model/Kimi and curator/answer/media
parity is required, continue with B's bounded trusted-session feasibility rather
than calling A equivalent. If the maintainer explicitly accepts the listed
feature losses, A has the clearest upstream process boundary. C is viable only
with an agreed feature subset and embedding maintenance commitment. D is valid
if the necessary authority cannot be granted safely. This is advice, not a
selection or approval.

The exact questions are: which feature/auth losses are acceptable; which nested
models and trusted UI/session adapters may run; whether browser/credential-command
modes are excluded or separately brokered; process-per-session retention versus
restart restoration and fork policy; public supported configuration/tool shape;
and whether to request an upstream supported embedding entry point. #1863 owns
the ruling and production criteria. Independently implementable follow-up slices
are executor packaging/pinning, authenticated roster/handle bridge, mandatory
egress/data-routing/taint/budget admission, trusted session/UI adapters if chosen,
and runtime/lifecycle/upgrade qualification. Each slice must preserve the common
boundary and the explicit unverified list; it cannot claim the whole issue from
a host-only search. Actual self-hoster packaging belongs in the public hosting
template, with dependency direction outward from brain-kit and no instance data.
