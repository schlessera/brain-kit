# @schlessera/brain-backend-pi

The OSS-default [`AgentBackend`](../ui-sdk/src/server/backend.ts) for the
brain-kit chat UI, purpose-built on the upstream
[`pi`](https://github.com/earendil-works/pi) coding-agent SDK
(`@earendil-works/pi-coding-agent`, pinned to `0.84.4`).

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

## Options

| Option | Default | Notes |
|---|---|---|
| `brainPath` | — | Absolute path to the brain repo; the agent's cwd. |
| `model` | — | Fallback model, `"vendor/modelId"` or `"modelId"`, when no profiles are set. |
| `profiles` | — | Selectable `{id,label,vendor?,model}` profiles; first is the default for new sessions. |
| `sessionDir` | `<brainPath>/.brain-kit-ui/sessions` | Where pi stores session JSONL trees. |
| `loadExtensions` | `true` | pi extensions (installed pi packages, repo-local extensions) load by default — the `tool_call` gate covers their tools, so e.g. `pi-mcp-adapter` (MCP servers from `.mcp.json`) and `pi-web-access` (web search/fetch) extend the surface safely. Set `false` to pin the surface to the curated tools. Skills + `AGENTS.md`/`CLAUDE.md` context always load — and BOTH cwd context files load when both exist, matching what the Claude backend reads. |
| `confirmBashPatterns` | shared `DEFAULT_CONFIRM_BASH_PATTERNS` | Regexes; a matching `bash` command raises a confirmation card even though bash is auto-allowed. `[]` disables confirmation. |
| `allowedTools` | `DEFAULT_PI_ALLOWED_TOOLS` | Tool names that run without an approval card. Every executed tool NOT in the list raises one. |
| `writeLock` | fresh in-process lock | Serializes mutating tool executions across all sessions of this backend (shared working tree). Inject one to share a lock with another in-process writer. |

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
  `git reset --hard`, `brain archive`, …).
- **`brain_update` with `status: "archived"` confirms first** (shared
  `archivesDocument`) — the same visibility change `brain_archive` is off the
  allowlist for, through a tool that is on it. Any other update runs
  unprompted.
- **Everything else asks** — e.g. a third-party MCP tool through
  `pi-mcp-adapter`, exactly like a non-allowlisted MCP tool on the Claude
  backend.

One place the posture does **not** mirror: an approval carrying `updatedInput`.
pi applies the edit in place, as its runtime intends, without re-checking the
edited input against the policy — so an approval can redirect a confirmed call.
The Claude backend cannot apply an edit from its PreToolUse hook and refuses
the approval instead. #145 holds that question for both.

A denial blocks the call with the host's message; pi feeds the block back to
the model as an `isError` tool result, so a denial never crashes the turn. An
approval may carry `updatedInput`, which patches the tool arguments in place
before execution. `bash` commands are additionally routed through
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
npm:pi-mcp-adapter npm:pi-subagents`); the brain-ui container does this on
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
that file already has the server's privileges. Closing it means routing every
read through the CLI as a subprocess, which is a different design for this
package rather than a patch to it.

## Environment

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
| `NOMINATIM_URL` | Reverse-geocoding endpoint. | https://nominatim.openstreetmap.org |
| `NOMINATIM_USER_AGENT` | Identifying User-Agent for Nominatim (usage-policy requirement). | brain-kit-ui/1.0 |

Reads whose variable *name* is configuration rather than code:

| Name comes from | What the value is used for |
| --- | --- |
| brain.config `embeddings.apiKeyEnv` | API key presence check for the configured embedding provider, read at call time under whatever name the config declares (default: GEMINI_API_KEY). |
| web-search provider catalog (`WEB_SEARCH_PROVIDERS`) | Presence check for each web-search provider's API key (EXA_API_KEY, PERPLEXITY_API_KEY, BRAVE_API_KEY, …), so a provider configured by environment rather than by `web-search.json` is not reported as unusable. Values are never read out. |

Generated from `packages/ui-backend-pi/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->
