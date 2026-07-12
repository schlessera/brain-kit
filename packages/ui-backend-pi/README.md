# @brainform/ui-backend-pi

The OSS-default [`AgentBackend`](../ui-sdk/src/server/backend.ts) for the
brainform chat UI, purpose-built on the upstream
[`pi`](https://github.com/earendil-works/pi) coding-agent SDK
(`@earendil-works/pi-coding-agent`, pinned to `0.80.6`).

It gives a knowledge-base agent a small, auditable tool surface instead of a
general coding agent's 30-plus tools: pi's built-in read/bash/edit/write are
disabled (`noTools: "builtin"`) and replaced with a curated set scoped to the
brain repository, each carrying its own permission gate.

```ts
import { createPiBackend } from "@brainform/ui-backend-pi";

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
| `sessionDir` | `<brainPath>/.brainform-ui/sessions` | Where pi stores session JSONL trees. |
| `loadExtensions` | `false` | Repo-provided pi extensions are **not** loaded by default (keeps the tool surface curated); skills + `AGENTS.md`/`CLAUDE.md` context always load. |

## Capabilities

| Capability | Value | Justification |
|---|---|---|
| `resume` | `true` | `SessionManager.open()` reopens any session JSONL by id. |
| `permissions` | `true` | Every mutating tool awaits `bridge.requestPermission()`. |
| `thinking` | `true` | `message_update`'s `thinking_delta` maps to `thinking_delta` frames. |
| `attachments` | `true` | Image attachments become pi `ImageContent` on `session.prompt({ images })`. |
| `askUser` | `true` | The `ask_user` tool routes to `bridge.askUser`; degrades to a tool error if the host lacks it. |
| `costReporting` | `true` | `session.getSessionStats().cost` (pi-ai per-token cost) is diffed per turn. |

## Curated tools & risk classes

The permission gate lives **inside** each tool's `execute()` — pi has no
pre-execution interception hook, and none is needed. Read-only tools run with no
round-trip; mutating tools first await `bridge.requestPermission()` and **throw**
on denial. pi's agent loop turns a thrown error into an `isError` tool result fed
back to the model, so a denial never crashes the turn.

| Tool | Risk | Gate | Containment |
|---|---|---|---|
| `read_file` | read | auto-allow | `safeResolve` inside repo |
| `grep` | read | auto-allow | search path `safeResolve`d; `cwd` = repo |
| `brain_search` | read | auto-allow | in-process `hybridSearch` (read-only db) |
| `brain_context` | read | auto-allow | in-process retrieval block (read-only db) |
| `ask_user` | read | auto-allow | routes to `bridge.askUser` |
| `write_file` | mutate | **approval** | `safeResolve` inside repo |
| `edit_file` | mutate | **approval** | `safeResolve`; `old_string` must be unique |
| `bash` | mutate | **approval** | `cwd` pinned to repo |
| `brain_add` | mutate | **approval** | in-process `ingest` (writes markdown + reindex) |

`brain_search` / `brain_context` / `brain_add` call `@brainform/core`
(`hybridSearch` / `ingest`) directly in-process rather than shelling out to the
`brain` CLI or MCP. Search degrades to FTS-only when no embedding key is
configured (the same keyless behaviour the CLI has).

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
