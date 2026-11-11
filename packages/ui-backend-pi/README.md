# @schlessera/brain-backend-pi

The OSS-default [`AgentBackend`](../ui-sdk/src/server/backend.ts) for the
brain-kit chat UI, purpose-built on the upstream
[`pi`](https://github.com/earendil-works/pi) coding-agent SDK
(`@earendil-works/pi-coding-agent`, pinned to `0.99.2` together with
`pi-agent-core` and `pi-ai`).

It gives a knowledge-base agent a brain-repo-scoped tool surface with the same
approval posture as the Claude backend: pi's built-in read/bash/edit/write are
disabled (`noTools: "builtin"`) and replaced with a curated set scoped to the
brain repository, gated by the outer Agent tool hooks and host permission RPC.
Externally configured extensions are currently refused because their complete
provider-input paths are unqualified.

```ts
import { createPiBackend } from "@schlessera/brain-backend-pi";

const backend = createPiBackend({
  brainPath: "/path/to/brain",
  profiles: [
    { id: "sonnet", label: "Claude Sonnet", vendor: "anthropic", model: "claude-sonnet-4-5" },
  ],
});
```

Model credentials are **not** managed here — pi resolves them from its own auth
storage (`~/.pi/agent/auth.json`) and provider env vars, exactly as the `pi` CLI
does.

## Native endpoint routing

For an explicitly declared built-in provider/model, the backend validates the
built-in identity and selects its configured model from the native
`ModelRuntime` performing inference. Pi's normal agent-directory discovery
(including `PI_CODING_AGENT_DIR`) owns `models.json`, authentication and model
cache paths. The brain's `sessionDir` controls transcripts, not native config.

On **each request**, a native authentication-supplied endpoint takes precedence;
otherwise the configured model endpoint is used. A `models.json` proxy is
therefore conditional on native authentication not supplying an endpoint.
The backend preserves native credential discovery/refresh, subscription/account
routing and billing ownership. It does not reject a supported configuration
solely because those endpoints differ or force native credentials to a proxy.
Native credential refresh may contact authentication servers.

This is a routing migration: new ordinary and autonomous turns now honor native
configured endpoints that a raw catalog model could previously ignore. Review
existing native endpoint/authentication configuration when adopting the change.
Model/provider identity and explicit picker profiles stay fixed; no custom-model
discovery or profile endpoint field is added. Ordinary disk resumes use native
configured lookup without overriding their saved model and still refuse fallback
to another model. Every turn reconstructs its runtime inside a worker; no runtime hot-reload
promise is added for edits to `models.json`.

Autonomous turns remain nonpersistent with the existing tool authority and
runtime compatibility checks. Endpoint routing does not enable autonomous
dispatch or replace its containment gate. The binding policy and verification
boundaries are in the [endpoint-routing decision](../../docs/decisions/pi-endpoint-routing.md).

## Host-held native authentication qualification

The offline native-auth qualification tests exercise the installed public
`ModelRuntime.getAuth` and `createAgentSession` APIs. They check current stored
keys, one locked OAuth refresh for concurrent callers, cancellation without
credential writeback, and sanitized relay failures. Native Codex SSE and
WebSocket fixtures preserve account, model, usage and fresh/resident/disk-resume
history. Through the existing HTTP relay, a WebSocket upgrade receives HTTP 405
and native transport falls back successfully to SSE. Usage and calculated cost
come from synthetic responses, not a billed provider observation.

These are native SDK compatibility controls, not an ordinary credential-free
Pi worker integration. The relay fixture retains fictional native OAuth tokens
for native request construction and checks that host headers replace worker
credentials. A plain placeholder cannot construct a Codex request because its
native adapter extracts an account claim first. Native authentication can also
supply a per-request endpoint, as the Copilot fixture demonstrates. Request
shape metadata must retain native truth; model or account labels grant no
recipient authority.

The maintenance fixture runs native command-bearing keys and headers in a real
restricted worker with read-only host HOME. Refresh writes to private scratch;
existing compare-and-swap writeback occurs while the host credential exclusion
is still held. Its startup view is an explicit copied test fixture, not managed
Btrfs admission proof. It does not solve exclusive credential-command admission
during a shared inference turn. There is no supported upstream command-executor
callback to replace with a host shell.

Ordinary host-held Pi routing remains incomplete under
[#1665](https://github.com/schlessera/brain-kit/issues/1665). Custom-origin
OAuth forwarding follows the approved
[per-credential origin rule](../../docs/decisions/pi-endpoint-routing.md#stored-oauth-recipient-authorization):
a non-first-party recipient requires explicit host-owned authorization for that
credential's exact canonical origin. Native `models.json`, including an alias
into writable project content, selects a route and grants no bearer recipient
authority. Validate the actual native destination on each dispatch; refuse an
unapproved recipient without endpoint substitution or credential transfer on
redirect. The existing custom-origin negative control captures an HTTP 400
fixture request; it grants no permission and makes no live account claim.
These tests add no runtime option or default activation, and do not establish
that the required ordinary host-side recipient check is implemented.

## GPT-6 profiles

The pinned catalog supports `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` and
`gpt-6.1-sol` for both `openai` (API credentials) and `openai-codex`
(subscription credentials). Models appear in the picker only when explicitly
configured. Keep existing profile ids and ordering when adding a model; the
first configured profile remains the backend's default for new sessions.

For example, append either profile to an existing `profiles` array:

```ts
import type { PiProfile } from "@schlessera/brain-backend-pi";

const additionalProfiles: PiProfile[] = [
  { id: "sol-6-1-api", label: "GPT-6.1 Sol (API)", vendor: "openai", model: "gpt-6.1-sol", thinkingLevel: "high" },
  { id: "sol-6-1-subscription", label: "GPT-6.1 Sol (subscription)", vendor: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "xhigh" },
];
```

GPT-6.1 Sol supports `low`, `medium`, `high`, `xhigh` and `max`; an omitted
level defaults to `medium`. Pi's Codex adapter also maps `minimal` to `low`.
The resolved model retains pi's provider metadata, including Responses
transport, reasoning support, pricing and context limits. GPT-6.1 Sol tool
calling requires [Responses](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
A keyless catalog lookup confirms resolution; account access still depends
on the provider's credentials and model availability.

## Options

| Option | Default | Notes |
|---|---|---|
| `brainPath` | — | Absolute path to the brain repo; the agent's cwd. |
| `model` | — | Fallback model, `"vendor/modelId"` or `"modelId"`, when no profiles are set. |
| `profiles` | — | Selectable `{id,label,vendor?,model,thinkingLevel?}` profiles; first is the default for new sessions. |
| `sessionDir` | `~/.local/state/brain-kit/pi/<SHA-256 of canonical brain path>/sessions` | Server-owned session JSONL trees outside the brain and its ancestors; aliases into the brain refuse. |
| `loadExtensions` | `false` | Curated tools only; installed extensions stay installed and inactive. Skills and both cwd `AGENTS.md`/`CLAUDE.md` files still load. `true` opts into discovery, but a loaded extension or loading error refuses a managed turn and reports incomplete collection. Before 0.45 the default was `true` (#3658). |
| `confirmBashPatterns` | shared `DEFAULT_CONFIRM_BASH_PATTERNS` | Regex sources, or `{ pattern, effect }`; a matching `bash` command raises a confirmation card even though bash is auto-allowed, and the card shows the pattern's `effect` (a bare source gets a generic sentence). `[]` disables confirmation. A nonempty list with no valid regex rejects construction; mixed lists report invalid entries and retain valid patterns and effects. |
| `allowedTools` | `DEFAULT_PI_ALLOWED_TOOLS` | Tool names that run without an approval card. Every executed tool NOT in the list raises one. |
| `writeLock` | fresh keyed lock | Legacy whole-lock serialization for authoritative server applications. Inject one to share a lock with another server writer. Worker scratch is separate per turn. |

## Reasoning effort

`profiles[].thinkingLevel` is the per-model default (`medium` when omitted).
`startTurn({ thinkingLevel })` overrides it for one message. Each prompt,
including an in-memory or reopened resume, resets from the current profile
before applying an override; a prior message never changes the next default.

`listProfiles()` advertises the model's supported levels from pi's installed
catalog. Unsupported requests resolve to the nearest lower supported level,
or the lowest supported level if none is lower. The runtime setter uses
`persist: false`, so neither a message nor a profile default rewrites pi's
global settings. For explicit overrides, `session_info` reports both the
requested level and the runtime-confirmed level.

The host queues messages carrying an effort override or a correlated chat
request as separate turns. Legacy messages can still use native `followUp()`.

## Capabilities

| Capability | Value | Justification |
|---|---|---|
| `resume` | `true` | The server reads JSONL by id and reconstructs the worker session with `SessionManager.inMemory`. |
| `permissions` | `true` | The outer Agent tool hook awaits `bridge.requestPermission()` for gated calls (non-allowlisted tools, destructive bash shapes). |
| `thinking` | `true` | `message_update`'s `thinking_delta` maps to `thinking_delta` frames. |
| `attachments` | `true` | Image attachments become pi `ImageContent` on `session.prompt({ images })`. |
| `askUser` | `true` | The `ask_user` tool routes to `bridge.askUser`; degrades to a tool error if the host lacks it. |
| `costReporting` | `true` | `session.getSessionStats().cost` (pi-ai per-token cost) is diffed per turn. |
| `concurrentSessions` | `true` | Busy-ness is per session: turns on different sessions run in parallel; a second turn on a running session rejects `BackendBusyError`. |
| `followUp` | `true` | `followUp()` injects a mid-turn message into the running turn via `session.prompt(text, { streamingBehavior: "followUp" })`. |

## Isolated turns and session migration

Every ordinary and autonomous turn probes the shared Linux/bubblewrap boundary
before loading extensions or creating an agent session. Unsupported hosts
refuse visibly, with no weaker fallback. Extension factories, custom tools and
shell children see a read-only brain and fresh writable scratch; `BRAIN_ROOT`
keeps CLI reads rooted in the brain, while CLI writes report the hosted
read-only diagnostic and name the curated tool. Shell output is never replayed
by the server.

The server owns permission decisions, bridge handlers and exact Markdown
applications. Strict bounded messages travel over protocol pipes, never sockets
or shared writable files. Bridge execution needs the exact server permission
receipt; applications recheck the live principal and operation in the server
route. Masks use the shared server-owned PNG operation with Pi’s existing filename
and result path. It validates exact browser bytes, image/mask bases, policy paths,
aliases, live authority and cancellation under the application lock. Cancellation kills the worker's PID
namespace and records any edits that already committed.

**Breaking migration, approved in #674 and #1038:** sessions and native pi state
must be outside the brain and its ancestors. Move existing JSONL transcripts
from `<brainPath>/.brain-kit-ui/sessions` into the new default directory, or
configure an external `sessionDir`. Existing session ids and history envelopes
are retained. `PI_CODING_AGENT_DIR` must also resolve outside the brain. Native
auth/model/settings files enter scratch through pipes; refreshed credentials
return only to the server-selected native auth file, refusing aliases and
concurrent changes. This filesystem boundary does not establish #676's complete
credential, ambient-configuration or egress containment, or enable autonomous
production dispatch. Pi continues to refuse voice turns because it declares no
voice membership.

## Parallel sessions

Each pi `AgentSession` is tracked in a per-`sessionId` map with its own
`TurnContext` and curated toolset — so two sessions' turns never share a bridge.
Every emitted frame is scoped with its `sessionId` so a multiplexing client can
demux concurrent sessions. Each turn owns one isolated worker; it is terminated
at completion or cancellation. Ordinary JSONL is persisted by the server over
pipes and reopened on the next turn. Session identities and history shapes stay
the same; autonomous turns persist nothing.

`followUp({ sessionId, prompt, attachments })` delivers a user message into a
session's **running** turn — pi's `"followUp"` streaming behaviour queues it
within the turn (delivered after the current assistant step and its tool calls),
as opposed to `"steer"`, which interrupts. Frames keep flowing through the running
turn's existing subscription. It rejects `BackendRequestError` when the session
has no running turn (the host then queues the message as the next turn instead).

**Shared-repo safety.** Authoritative applications use the server route's
contention keys and recheck exact authority under the write lock before writing
and indexing. The legacy `writeLock` option supplies a shared whole lock to that
route. Worker tools retain their local contention keys; each turn has separate
writable scratch, and `bash` cannot stage or mutate the read-only brain.
Permission decisions precede execution and locking.

## Curated tools, permissions & risk classes

Approvals live in ONE place: `createPermissionGate` registers a `tool_call`
handler (as an inline extension on every session's resource loader) that fires
before every tool execution — curated and extension-registered alike. The
policy mirrors the Claude backend:

- **Allowlisted tools run with no round-trip** (`DEFAULT_PI_ALLOWED_TOOLS`:
  every curated tool except `brain_archive`, including the four host-owned
  web tools).
  This includes `brain_read_base`, which reads the authoritative content and
  base hash before an edit. An explicit `allowedTools` list still replaces
  the default; native base reads still require an admitted grant for the exact
  path and a live turn.
- **Destructive `bash` shapes confirm first** (shared
  `DEFAULT_CONFIRM_BASH_PATTERNS`: recursive delete, `git push --force`,
  `git reset --hard`, `brain archive`, …). Each pattern carries its effect
  in words ("delete a directory and everything inside it"), and that is what
  the card says.
- **`brain_update` with `status: "archived"` confirms first** (shared
  `archivesDocument`) — the same visibility change `brain_archive` is off the
  allowlist for, through a tool that is on it. Any other update runs
  unprompted.
- **Everything else asks** — e.g. a third-party MCP tool through
  `pi-mcp-adapter`, exactly like a non-allowlisted MCP tool on the Claude
  backend.

An approval that carries an edited input (`updatedInput`) is re-checked
before it is applied, the same way on both backends (#145). The shared
`checkEditedApproval` runs the confirm policy again on the edited input: an
edit that needs no confirmation, or only the confirmations the card already
showed (the same command, the same archived document), is applied; one
that needs a confirmation the card did not show is refused whole, and the model
is told why. The write lock is taken on the edited input's key. pi applies a passing edit by patching the tool
arguments in place, as its runtime intends.

A denial blocks the call with the host's message; pi feeds the block back to
the model as an `isError` tool result, so a denial never crashes the turn. An
approval may carry `updatedInput`, which, once re-checked as above, patches
the tool arguments in place before execution. `bash` commands are additionally routed through
[rtk](https://github.com/rtk-ai/rtk) when the binary is on PATH — a
token-optimizing proxy rewrite (`git status` → `rtk git status`) applied AFTER
the gate, so confirm patterns always see the command as the model wrote it.
Bash results contain combined command output without echoing the command. Empty
output reads `(no output)`; a nonzero exit retains its trailing `[exit N]` marker.

| Tool | Risk | Gate | Containment |
|---|---|---|---|
| `read_file` | read | auto-allow | `safeResolve` inside repo |
| `grep` | read | auto-allow | search path `safeResolve`d; `cwd` = repo |
| `brain_search` | read | auto-allow | in-process `hybridSearch` (read-only db) |
| `brain_context` | read | auto-allow | in-process retrieval block (read-only db) |
| `brain_read` | read | auto-allow | `safeResolve` inside repo |
| `brain_list` | read | auto-allow | in-process `filterSearch` (read-only db) |
| `brain_graph` | read | auto-allow | in-process link-graph walk (read-only db) |
| `brain_read_many` | read | auto-allow | each request through `safeResolve`, as `brain_read`; core's bounded multi-read |
| `ask_user` | read | auto-allow | routes to `bridge.askUser` |
| `ask_user_list` | read | auto-allow | routes to `bridge.askUserList`; refuses a turn declaring `noGrantSurface` |
| `get_current_location` | read | auto-allow | routes to `bridge.getLocation`; reverse-geocoded server-side |
| `query_activity` | read | auto-allow | routes to `bridge.queryActivity` (read-only record) |
| `turn_temp` | read (turn temp only) | auto-allow | usage and scoped purge through the host's held worker descriptor; linked files are kept unless named paths force their removal |
| `show_block` | read | auto-allow | validates and echoes one answer block; no bridge, no side effect |
| `web_search`, `fetch_content`, `get_search_content`, `source_check` | read | auto-allow | routes to `bridge.webAccess`: the host's web executor runs the call; interactive sessions only, never autonomous |
| `request_image_mask` | mutate | auto-allow (the mask editor IS the approval) | server PNG application; writes `<image>.mask.png` |
| `write_file` | mutate | auto-allow | server-validated Markdown application |
| `edit_file` | mutate | auto-allow | server-validated Markdown application; `old_string` must be unique |
| `bash` | mutate | auto-allow, **confirm patterns ask** | writable worker scratch; the brain remains read-only |
| `brain_add` | mutate | auto-allow | server-owned capture (Markdown + reindex) |
| `brain_update` | mutate | auto-allow, **`status: "archived"` asks** | server-owned frontmatter/body update + reindex |
| `brain_archive` | mutate | **approval** | server-owned archive (visibility change) |
| `propose_policy_change` | mutate | **approval**, then the host's diff card | host validates the complete policy; only an explicit on-screen approval writes `context/policies/governance.md` |

`get_current_location`, `query_activity` and `request_image_mask` register only
when the host bridge provides the corresponding seam, and the system-prompt
brief names them on the same condition.

Read tools call core inside the read-only worker: graph and listing use the
supported `@schlessera/brain/queries` API, while search/context use the
lockstep-only `@schlessera/brain/internal` entry. Authoritative writes go only
through the server application route; a missing route visibly refuses. Search
degrades to FTS-only when no embedding key is configured (the same keyless
behaviour the CLI has).

## Web tools

Web search runs on the host, not in the worker (#3685, epic #2765). Ordinary
interactive sessions list four curated forwarding tools, `web_search`,
`fetch_content`, `get_search_content` and `source_check`, with the pinned
upstream pi-web-access parameters narrowed to what the host admits. Each call
crosses the worker's bridge RPC under its exact permission grant. The host
binds it to the turn's principal, session, profile and policy revision, runs it
in its web executor and returns one JSON envelope. Provider configuration and
credentials never enter the worker. A `responseId` is a host handle scoped to
the calling session. Answer mode, summaries, curator review, video analysis
and the browser-cookie and credential-command modes answer `unsupported`. Each
result passes the input-safety collector before the model receives it.
Autonomous turns get none of these tools. A host without a web executor
refuses them before they run.

The host web executor (#3686) runs the pinned upstream extension,
`pi-web-access` 0.41.0, in a real Pi SDK session on the host, one child
process per conversation. That process loads only that extension, with empty
settings and no discovery. It runs in a fresh private directory (HOME, Pi
agent directory, cache and temp) beside the UI database, which workers
already have masked. It reads a sanitized copy of the host's
`web-search.json` and gets the catalog providers' API keys from the host
environment. The copy turns off the extension's workflow, curator, summary,
media, GitHub-cloning, command and browser-cookie paths, and removes every
`!command` credential. Settings, the Settings card and the system-prompt
brief list the same unavailable features (`WEB_TOOL_UNAVAILABLE_FEATURES`).
The directory is removed when the executor ends; an executor that dies is
replaced on the next call, and its stored results go with it. Mandatory
egress and per-call admission are #3687; subscription and current-model
search is #3688.

## Extensions (MCP, subagents)

Managed turns currently refuse every loaded external extension, including
`pi-web-access`, `pi-mcp-adapter` and `pi-subagents`. Web search does not need
a worker-loaded `pi-web-access` (see Web tools above): the host runs its own
pinned copy. A tool permission gate or a
final `tool_result` observer cannot qualify these packages: Pi also exposes live
messages/results after that observer, independent custom-message injection and
provider-payload hooks. There is no trusted extension path, name or package
exception. The curated tools are therefore the default (`loadExtensions: false`;
hosted: `BRAIN_UI_PI_EXTENSIONS=curated`), and startup names any installed
extension it is leaving inactive.

Opting into discovery (`BRAIN_UI_PI_EXTENSIONS=discover`) does not make an
extension usable. The hosted module inspects Pi's extension configuration
(settings package lists and the global/project extension directories, read
through Pi's package manager without importing or installing anything) before
each roster read and each non-restricted turn. It blocks Pi when that
configuration would fail every managed turn: with discovery on, any extension
or loading error; in the curated default, a configured package that is not
installed (managed workers require prepared packages even when they load no
extension); in either mode, an inspection failure. Blocked, Pi lists its profiles as unavailable
with reason `unsupported-configuration` and refuses the turn before a worker
starts, with an actionable message. The input-safety collector's failure path
is not engaged and other backends keep running. Restricted autonomous turns
load neither and are unaffected. A direct `createPiBackend()` has no such gate
and relies on the refusal below.

As a backstop, the runtime checks the complete loaded extension set and loading errors before
session creation and again before Agent provider dispatch, including changed
configuration and resume. Refusal awaits the existing host failure notice and
stops the worker. The host also reports initialization loss before acquisition
settles and acknowledges coverage only after successful initialization. Durable
retention belongs to the host collector; a rejected
notice alone does not prove it. Unknown history remains restrictive under the
[session safety contract](../../docs/integration-contract/http.md).

No managed extension receives `ctx.executeTool()`. The curated tool
implementations do not call it, so nested extension execution is unavailable;
no nested-call safety capability is claimed. The prior inline nested guard has
been removed with extension execution.

Managed workers also disable cache warming. In the pinned SDK, warming refresh
calls `ModelRuntime.streamSimple()` directly, outside the Agent stream hook.
The worker pins `SettingsManager.getCacheWarmingMode()` to `off`, which the
installed warmer checks before starting and again during refresh. Settings
reloads and mode writes cannot enable that path. No provider-facing message,
prompt, tool definition or historical result is rewritten by these fences.

Installed-SDK loopback captures exercise refusal, real curated grep, changed
configuration and an actual seeded warming refresh without a timer wait. They
use in-memory SQLite for the focused collector proof. Supported-host native
workers, both keyless provider-history guards and complete selected hosted proof
remain required; these local captures do not establish those qualifications.

## Event mapping (pi → wire protocol)

| pi `AgentSessionEvent` | Wire frame(s) |
|---|---|
| `message_update` + `text_delta` | `text_delta` |
| `message_update` + `thinking_delta` | `thinking_delta` |
| `tool_execution_start` | `tool_use_start` + `tool_use_complete` (full input) + `status: tool_executing` |
| `tool_execution_end` | `tool_result` (with `isError`) |
| turn end (`session.prompt` resolves) | `result` (or `status: cancelled` on abort) |

Tool arguments arrive complete rather than streamed, so `tool_use_complete`
carries the full input and no `tool_input_delta` frames are emitted (the protocol
allows this). `session_info` is emitted as soon as the session id is known, before
any content frames. The permission round-trip (`tool_approval_request`) is emitted
by the host's `bridge.requestPermission`, not by this backend.

## History

The backend owns the raw pi JSONL transcripts; `getHistory` normalizes the
**active branch** (`SessionManager.getBranch()`, root → leaf) into the wire
protocol's `SessionHistoryMessage[]` at read time. pi keeps tool calls inside the
assistant message and tool results as separate `toolResult` messages; the
normalizer threads each result back onto its assistant tool call. `bashExecution`,
`custom`, and compaction/branch-summary entries are flattened out (the `parts`
field is additive). Session cost/turn aggregates are left to the host's `sessions`
metadata table.

Promoted answer links and authoritative server receipts live in host-owned
`session-replay/` metadata below `sessionDir`, outside the provider transcript.
Replay applies each display mapping to its native message and exact original
text. Receipts overlay the matching call on the active branch; a direct server
application with no runtime call gets a display-only row at its original turn.
A direct effect committed before any native message retains a session-root
position and remains visible even when no runtime transcript file exists.
Neither path manufactures a model message in the session file. After a worker
exits, the host may append the missing result for an actual runtime-written
call whose committed server application has no runtime result; existing results
are never replaced. The installed Pi adapter otherwise repairs such orphaned
calls with its own error result.

## Testing

`bun run test packages/ui-backend-pi` — no live LLM calls. Covers permission gating, path containment,
the in-process `brain_search`/`brain_context` wrappers against a keyless FTS
corpus, the pure `mapPiEvent` adapter, and history normalization (synthetic +
a real `SessionManager` session file).

## The exec wrapper, and what it does not cover

`BRAIN_UI_EXEC_WRAPPER` (below) is an absolute path to an executable that the
`bash` and `grep` tools are launched through:
`<wrapper> bash --noprofile --norc -c <cmd>` and `<wrapper> grep …`. It is an
argv[0], never a command line — no shell parses it — so a host can run the
agent's children as another user without this package knowing how. Unset,
spawns are exactly what they were. When it is set, the child leads its own
process group and an abort signals the group, because a uid drop otherwise
makes `kill(2)` fail with EPERM and leaves an aborted turn running.

The `bash` tool's shell is not a login shell and reads no startup file: not
`/etc/profile`, not a profile or `.bashrc` under `HOME`, and not the file
`BASH_ENV` or `ENV` names, which are removed from the command's environment
even when an operator admits them. A command's `PATH` and variables are exactly
the filtered environment ([Environment](#environment)). A tool that only a login
profile put on `PATH` belongs on the server's own `PATH`; a variable a profile
exported is set in the server's environment and admitted through
`BRAIN_UI_SUBPROCESS_ENV_EXTRA`.

**It does not cover `brain.config.ts`.** `createBrainAccess` calls
`initContext`, which `await import`s the repository's config — executable
TypeScript owned by the brain, evaluated in the server process, not in a child.
No wrapper reaches it. The wrapper bounds what the agent's *tools* can do; it
does not bound what the brain's own config can do, and anyone who can write
that file already has the server's privileges. Search, context and writes still
initialize this config. Graph and listing instead use core's supported
`@schlessera/brain/queries` results and do not initialize config or providers.
Moving the remaining operations through the CLI is a different design for this
package rather than a patch to it.

Graph and listing open the current index read-only for each call, with one
snapshot for compatibility and results. A replaced index is read on the next
call. Incompatible or corrupt indexes request a rebuild, busy indexes request
a retry, and native database diagnostics never reach these tool errors. Search,
context and writes retain native handles through the explicitly unsupported
`@schlessera/brain/internal` entry; this implementation path requires matching
lockstep versions and is not a supported query API.

## Environment

The location tool always retains raw coordinates. Reverse addresses use the
shared geo client and cache. The default public Nominatim endpoint sends no
request until `NOMINATIM_PUBLIC_SERVICE_ELIGIBLE=true` explicitly records informed
eligibility under its [policy](https://operations.osmfoundation.org/policies/nominatim/).
The flag grants no permission; generic LLM-platform offerings and bulk,
autocomplete or systematic queries are excluded. Use a suitable `NOMINATIM_URL`
for those uses and identify the application/operator with `NOMINATIM_USER_AGENT`.
`BRAIN_UI_REVERSE_GEOCODE=false` prevents requests even when eligible.

Every variable this package reads, and what happens when it is unset. This
table is generated from the package's env chokepoint — the single file allowed
to touch `process.env`.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `BRAIN_UI_EXEC_KILLER` | Absolute path to an authorised helper that cancels a wrapped process group, invoked as `<killer> <pgid> <TERM\|KILL\|INT>`. Needed only when the wrapper changes uid: signalling then fails with EPERM however the group is arranged, and an aborted turn would keep running. | (none — signal the group directly) |
| `BRAIN_UI_EXEC_WRAPPER` | Absolute path to an executable every tool subprocess is launched through, as `<wrapper> <program> <args…>`. Lets a host run the agent's children as another user without this package knowing how. It is an argv[0], never a command line: no shell parses it. Unset, spawns are exactly what they were. | (none — spawn the program directly) |
| `BRAIN_UI_PI_CREDENTIAL_ORIGINS` | Exact origins (scheme, host and port) each pi provider's credential may reach through a governed turn's inference relay, besides the origins of that provider's built-in models: `provider=origin[,origin];provider=origin`. Required when pi's models.json points a provider at another origin on a host with managed native storage; otherwise that turn is refused before its credential is read. A malformed entry refuses every relayed pi turn. | — |
| `BRAIN_UI_REVERSE_GEOCODE` | "0"/"off"/"false" disables reverse geocoding in the location tool (raw coordinates only). | enabled |
| `BRAIN_UI_SUBPROCESS_ENV_EXTRA` | Comma-separated environment variable names to admit to pi tool subprocesses when an operator integration needs a variable outside the shipped agent allowlist. Names are trimmed; malformed entries are ignored; the control variable itself is never forwarded. | (empty) |
| `GEMINI_API_KEY` | Default API key gating the brain's embedding provider (default name only — a config `apiKeyEnv` can point elsewhere). Absent key degrades search to FTS-only. | — |
| `NOMINATIM_PUBLIC_SERVICE_ELIGIBLE` | Explicit informed public Nominatim eligibility; enabled alone does not qualify. Configure a suitable endpoint for excluded uses. | false |
| `NOMINATIM_URL` | Reverse-geocoding endpoint. | https://nominatim.openstreetmap.org |
| `NOMINATIM_USER_AGENT` | Identifying User-Agent for Nominatim (usage-policy requirement). | brain-kit-ui/1.0 |

Reads whose variable *name* is configuration rather than code:

| Name comes from | What the value is used for |
| --- | --- |
| brain.config `embeddings.apiKeyEnv` | API key presence check for the configured embedding provider, read at call time under whatever name the config declares (default: GEMINI_API_KEY). |
| filtered environment snapshot (`subprocessEnv`) | At each tool spawn, forwards the SDK agent allowlist plus valid operator names from BRAIN_UI_SUBPROCESS_ENV_EXTRA and explicitly admitted per-spawn names. The control variable itself is never forwarded. This is internal transport, not unrestricted inheritance or additional supported configuration. |
| pi provider API key for a restricted autonomous turn | The selected provider's key from pi's own environment variable, or a `$NAME` reference in `auth.json` or `models.json`, read in the server for the inference relay. The worker never receives the value. |
| web-search provider catalog (`WEB_SEARCH_PROVIDERS`) | Presence check for each web-search provider's API key (EXA_API_KEY, PERPLEXITY_API_KEY, BRAVE_API_KEY, …), so a provider configured by environment rather than by `web-search.json` is not reported as unusable. Values are never read out. |

Generated from `packages/ui-backend-pi/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->

## Policy import migration

`DEFAULT_PI_ALLOWED_TOOLS` and `TOOL_RISK` moved from the ordinary package
entry to `@schlessera/brain-backend-pi/internal` for first-party implementation
sharing, with no compatibility guarantee. External backend authors use the
SDK's supported permission toolkit and their runtime's own policy. The
[classification](../../docs/decisions/backend-authoring-toolkit.md) records
these names separately from the supported input formats and turn posture.
Runtime defaults and permission behavior are unchanged.


## Measuring isolated startup

From a development checkout, run `bun packages/ui-backend-pi/scripts/measure-startup.ts` (three runs
by default; `--runs=1` runs one). It uses the installed Pi SDK, a real extension
and fresh isolated workers, with deterministic Anthropic SSE on loopback inside
a network namespace. Missing namespace prerequisites fail the command. It uses
explicit copied fixture inputs to measure the backend; it does not qualify
native Btrfs admission, journal work or remote provider latency.

Each receipt contains a new turn and a resumed turn with about 300 KiB of
selected transcript plus 128 unrelated conversations. Timings are milliseconds:
`preparation` includes transcript loading and sandbox preparation; `spawn` is
the synchronous launcher; `worker_started.elapsedMs` includes bootstrap and
static imports; `resources` covers resource/extension loading; `session` covers
the complete in-worker session open **including resources**; `initialize` also
includes private settings preparation. `firstFrameMs` is the first backend
frame, and `providerRequestMs` records arrival of the first request at the
loopback provider. Elapsed values are measured in the parent; worker durations
use the worker's monotonic clock. Do not add overlapping durations together.

The 2026-10-16 three-run baseline and direct-transcript optimisation measured:

| Median | Before | After |
| --- | ---: | ---: |
| New first frame | 644.6 ms | 640.3 ms |
| Resumed first frame | 736.0 ms | 649.3 ms |
| Resumed preparation | 154.0 ms | 43.1 ms |
| Resumed first provider request | 772.5 ms | 689.4 ms |

Worker bootstrap/imports dominate this fixture (roughly half a second after
spawn). Direct UUID transcript lookup removes archive parsing from resumed
turns; legacy SDK filenames retain discovery on their first resume. The
measurement does not reproduce the reported multi-second hosted delay or
attribute that whole delay to the archive scan. Absolute times vary by host;
the regression guard asserts that canonical resume never lists the archive.
The runtime proof checks fresh worker PIDs, a fresh private scratch marker and
the read-only host HOME on consecutive turns. It retains no worker or session
across turns. The existing backend logger receives `Pi startup phase` and
`Pi startup ready` debug observations without transcript or credential content.

## SDK requirements

The factory and descriptor validate the actual imported `pi-coding-agent`,
`pi-agent-core` and `pi-ai` copies against their declarations in this package's
manifest. That includes nested core/AI copies used by the primary SDK; a valid
hoisted dependency cannot vouch for them. SDK metadata is read from each
resolved package's owning manifest and must retain its expected name and full
SemVer version.

Optional `versionRequirements: { sdk: "0.99.2" }` on `createPiBackend` or the
module context composes a full SemVer minimum with the primary
`@earendil-works/pi-coding-agent` constraint. It cannot weaken any package pin.
The descriptor's asynchronous `probeRuntime` reports `{ sdk: { name, version } }`
without executing a vendor CLI. Pi runs in process and has no separate runtime
identity, so a requested `versionRequirements.runtime` refuses with an action
to use an SDK requirement instead. Inactive Claude configuration does not load
or probe the Claude backend.
