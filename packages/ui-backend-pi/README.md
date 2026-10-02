# @schlessera/brain-backend-pi

The OSS-default [`AgentBackend`](../ui-sdk/src/server/backend.ts) for the
brain-kit chat UI, purpose-built on the upstream
[`pi`](https://github.com/earendil-works/pi) coding-agent SDK
(`@earendil-works/pi-coding-agent`, pinned to `0.99.2` together with
`pi-agent-core` and `pi-ai`).

It gives a knowledge-base agent a brain-repo-scoped tool surface with the same
approval posture as the Claude backend: pi's built-in read/bash/edit/write are
disabled (`noTools: "builtin"`) and replaced with a curated set scoped to the
brain repository, gated by a single `tool_call` permission gate that also
covers extension-registered tools (web search, MCP adapters).

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
| `sessionDir` | `<brainPath>/.brain-kit-ui/sessions` | Where pi stores session JSONL trees. |
| `loadExtensions` | `true` | pi extensions (installed pi packages, repo-local extensions) load by default — the `tool_call` gate covers their tools, so e.g. `pi-mcp-adapter` (MCP servers from `.mcp.json`) and `pi-web-access` (web search/fetch) extend the surface safely. Set `false` to pin the surface to the curated tools. Skills + `AGENTS.md`/`CLAUDE.md` context always load — and BOTH cwd context files load when both exist, matching what the Claude backend reads. |
| `confirmBashPatterns` | shared `DEFAULT_CONFIRM_BASH_PATTERNS` | Regex sources, or `{ pattern, effect }`; a matching `bash` command raises a confirmation card even though bash is auto-allowed, and the card shows the pattern's `effect` (a bare source gets a generic sentence). `[]` disables confirmation. A nonempty list with no valid regex rejects construction; mixed lists report invalid entries and retain valid patterns and effects. |
| `allowedTools` | `DEFAULT_PI_ALLOWED_TOOLS` | Tool names that run without an approval card. Every executed tool NOT in the list raises one. |
| `writeLock` | fresh in-process lock | Serializes mutating tool executions across all sessions of this backend (shared working tree). Inject one to share a lock with another in-process writer. |

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
| `resume` | `true` | `SessionManager.open()` reopens any session JSONL by id. |
| `permissions` | `true` | The `tool_call` gate awaits `bridge.requestPermission()` for gated calls (non-allowlisted tools, destructive bash shapes). |
| `thinking` | `true` | `message_update`'s `thinking_delta` maps to `thinking_delta` frames. |
| `attachments` | `true` | Image attachments become pi `ImageContent` on `session.prompt({ images })`. |
| `askUser` | `true` | The `ask_user` tool routes to `bridge.askUser`; degrades to a tool error if the host lacks it. |
| `costReporting` | `true` | `session.getSessionStats().cost` (pi-ai per-token cost) is diffed per turn. |
| `concurrentSessions` | `true` | Busy-ness is per session: turns on different sessions run in parallel; a second turn on a running session rejects `BackendBusyError`. |
| `followUp` | `true` | `followUp()` injects a mid-turn message into the running turn via `session.prompt(text, { streamingBehavior: "followUp" })`. |

## Parallel sessions

Each pi `AgentSession` is tracked in a per-`sessionId` map with its own
`TurnContext` and curated toolset — so two sessions' turns never share a bridge.
Every emitted frame is scoped with its `sessionId` so a multiplexing client can
demux concurrent sessions. Up to 5 sessions stay resident in memory; beyond that,
**idle** (not currently running) sessions are disposed least-recently-used-first
at the end of a turn and reopened from their on-disk JSONL on the next resume.
Running sessions are never evicted.

`followUp({ sessionId, prompt, attachments })` delivers a user message into a
session's **running** turn — pi's `"followUp"` streaming behaviour queues it
within the turn (delivered after the current assistant step and its tool calls),
as opposed to `"steer"`, which interrupts. Frames keep flowing through the running
turn's existing subscription. It rejects `BackendRequestError` when the session
has no running turn (the host then queues the message as the next turn instead).

**Shared-repo safety.** Mutations serialize per CONTENTION KEY (a `KeyedLock`),
not on one global mutex: file writes lock `path:<abs>` (same file serializes,
different files run in parallel), the brain document tools share a
`brain-docs` key (write + reindex bursts), and `bash` locks the repo-wide
`repo-git` key ONLY when the command touches git staging/history or the brain
CLI's write path (shared `bashLockKey` policy from ui-sdk — the same
classification the Claude backend uses). Builds, greps, curls and other
read-shaped bash run lock-free, so parallel sibling tool calls and parallel
sessions actually run in parallel. Read-class tools never take a lock. The
permission round-trip happens in the `tool_call` gate **before** any lock.
Injecting the legacy `writeLock` option restores whole-lock serialization.

## Curated tools, permissions & risk classes

Approvals live in ONE place: `createPermissionGate` registers a `tool_call`
handler (as an inline extension on every session's resource loader) that fires
before every tool execution — curated and extension-registered alike. The
policy mirrors the Claude backend:

- **Allowlisted tools run with no round-trip** (`DEFAULT_PI_ALLOWED_TOOLS`:
  every curated tool except `brain_archive`, plus `pi-web-access`'s
  `web_search`/`fetch_content`).
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

| Tool | Risk | Gate | Containment |
|---|---|---|---|
| `read_file` | read | auto-allow | `safeResolve` inside repo |
| `grep` | read | auto-allow | search path `safeResolve`d; `cwd` = repo |
| `brain_search` | read | auto-allow | in-process `hybridSearch` (read-only db) |
| `brain_context` | read | auto-allow | in-process retrieval block (read-only db) |
| `brain_read` | read | auto-allow | `safeResolve` inside repo |
| `brain_list` | read | auto-allow | in-process `filterSearch` (read-only db) |
| `brain_graph` | read | auto-allow | in-process link-graph walk (read-only db) |
| `ask_user` | read | auto-allow | routes to `bridge.askUser` |
| `ask_user_list` | read | auto-allow | routes to `bridge.askUserList`; refuses a turn declaring `noGrantSurface` |
| `get_current_location` | read | auto-allow | routes to `bridge.getLocation`; reverse-geocoded server-side |
| `query_activity` | read | auto-allow | routes to `bridge.queryActivity` (read-only record) |
| `show_block` | read | auto-allow | validates and echoes one answer block; no bridge, no side effect |
| `request_image_mask` | mutate | auto-allow (the mask editor IS the approval) | `safeResolve`; writes `<image>.mask.png` |
| `write_file` | mutate | auto-allow | `safeResolve` inside repo |
| `edit_file` | mutate | auto-allow | `safeResolve`; `old_string` must be unique |
| `bash` | mutate | auto-allow, **confirm patterns ask** | `cwd` pinned to repo |
| `brain_add` | mutate | auto-allow | in-process `ingest` (writes markdown + reindex) |
| `brain_update` | mutate | auto-allow, **`status: "archived"` asks** | `safeResolve`; frontmatter/body update + reindex |
| `brain_archive` | mutate | **approval** | in-process `archiveDocument` (visibility change) |

`get_current_location`, `query_activity` and `request_image_mask` register only
when the host bridge provides the corresponding seam, and the system-prompt
brief names them on the same condition.

The brain tools call `@schlessera/brain` (`hybridSearch` / `ingest` /
`filterSearch` / `archiveDocument`) directly in-process rather than shelling
out to the `brain` CLI or MCP — the same surface the Claude backend reaches
via the brain repo's `mcp__brain__*` server, without the subprocess. Search
degrades to FTS-only when no embedding key is configured (the same keyless
behaviour the CLI has).

## Extensions (web search, MCP)

pi has no built-in web access or MCP client; both come from the pi package
ecosystem, loaded by default (`loadExtensions: true`):

- **`pi-web-access`** — `web_search` / `fetch_content`, auto-allowed,
  mirroring Claude's WebSearch/WebFetch. Providers are configured in
  `~/.pi/web-search.json`; Settings → Models → Web search writes it (see
  `WEB_SEARCH_PROVIDERS` in `@schlessera/brain-ui-sdk/server` for the
  catalog). Enabled providers are written as `searchRouting.providers`
  ordered cheapest-first, so a free provider (zero-config Exa) answers the
  ordinary case and a paid one is reached only when the cheap ones fail.

  Two traps, handled in `webSearchBrief` and the settings route: a
  `provider`/`searchProvider` key in that file OVERRIDES `searchRouting`
  outright — and pi's own `/curator` command writes one back — so a write
  that owns the chain must delete both; and the extension's tool description
  statically names ~28 providers regardless of configuration, so the
  system-prompt brief names the ones actually reachable and says the others
  are not. A provider with no credential (config key or env var) is dropped
  from the brief and refused by the settings route, since the extension
  would skip it at search time anyway.
- **`pi-mcp-adapter`** — MCP servers from the repo's `.mcp.json` (and standard
  MCP config paths) behind one lazy proxy tool. Its calls are NOT allowlisted,
  so each one raises an approval card — same posture as non-allowlisted MCP
  tools on the Claude backend. Note the brain's own MCP server is redundant
  here (the curated tools above cover it in-process).
- **`pi-subagents`** — the `subagent` fan-out tool (parallel reviews,
  research, scoped worker agents), parity with Claude's Agent tool and
  auto-allowed like it. When the package is installed, the system-prompt
  brief names the tool and encourages fan-out; without it, the brief tells
  the model to batch independent tool calls instead (pi executes sibling
  tool calls concurrently by default). NOTE: a child agent's own tool calls
  run inside pi's child session with that agent's declared tools, not
  through this backend's gate — delegation itself is the reviewed act.

Install them into the pi agent dir (`pi install npm:pi-web-access
npm:pi-mcp-adapter npm:pi-subagents`); a container deployment can do this on
boot.

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

## Testing

`bun test` — no live LLM calls. Covers permission gating, path containment,
the in-process `brain_search`/`brain_context` wrappers against a keyless FTS
corpus, the pure `mapPiEvent` adapter, and history normalization (synthetic +
a real `SessionManager` session file).

## The exec wrapper, and what it does not cover

`BRAIN_UI_EXEC_WRAPPER` (below) is an absolute path to an executable that the
`bash` and `grep` tools are launched through: `<wrapper> bash -lc <cmd>`. It is
an argv[0], never a command line — no shell parses it — so a host can run the
agent's children as another user without this package knowing how. Unset,
spawns are exactly what they were. When it is set, the child leads its own
process group and an abort signals the group, because a uid drop otherwise
makes `kill(2)` fail with EPERM and leaves an aborted turn running.

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
