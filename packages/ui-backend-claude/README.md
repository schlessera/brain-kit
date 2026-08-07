# @schlessera/brain-backend-claude

The flagship [`AgentBackend`](../ui-sdk/README.md) for the brain-kit chat UI,
built on the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). It
runs the full Claude Code toolset over your brain repository and adapts the
SDK's stream to the wire protocol.

```ts
import { createClaudeBackend } from "@schlessera/brain-backend-claude";

const backend = createClaudeBackend({
  brainPath: "/path/to/brain",
});
```

Auth comes from the environment the SDK already understands —
`CLAUDE_CODE_OAUTH_TOKEN` (subscription, preferred) or `ANTHROPIC_API_KEY`
(pay-as-you-go; setting it overrides the token, so keep it unset unless you
mean it).

## Options

| Option | Default | Notes |
|---|---|---|
| `brainPath` | — | Working directory for the agent — the brain repo. |
| `claudeCodePath` | SDK discovery | Path to the native `claude` executable when it isn't on PATH. |
| `profiles` | `DEFAULT_PROFILES` | Selectable inference profiles; first is the default. Pass a **function** when the roster can change at runtime (see model discovery) — an array is captured once. |
| `allowedTools` | `DEFAULT_ALLOWED_TOOLS` | Backend-wide allowlist; a profile's own `allowedTools` overrides it. |
| `writeLock` | fresh per-instance lock | Serializes mutating tool executions across all sessions of this backend. Inject a shared one to coordinate with other in-process writers. |

## Model discovery

`createModelSource({ brainPath })` keeps a roster of the models the current
credential can actually use, read from the Anthropic Models API. It works with
either `ANTHROPIC_API_KEY` (`x-api-key`) or a `CLAUDE_CODE_OAUTH_TOKEN`
subscription token (`Authorization: Bearer` + the `oauth-2025-04-20` beta
header); with neither, it yields an empty roster instead of throwing.

Dated snapshot ids are canonicalized to their public alias
(`claude-haiku-4-5-20251001` → `claude-haiku-4-5`) — some models are listed
*only* in dated form, so dropping them would lose the model entirely. Each new
alias is confirmed with a `GET /v1/models/{alias}` before use and the answer is
remembered, so a steady-state refresh is one request.

```ts
const source = createModelSource({ brainPath, ttlMs: 24 * 60 * 60 * 1000 });
const backend = createClaudeBackend({
  brainPath,
  profiles: () => [...declaredProfiles, ...defineProfiles(source.list())],
});

await source.ensureFresh(); // in front of a request: awaits only on a cold start
```

`list()` is synchronous and cache-backed — rendering a picker never waits on the
network. Results persist to `<brainPath>/.brain-ui/anthropic-models.json`, so a
restart serves the last known roster immediately. A failed refresh keeps the
previous list and reports the reason via `state().error`.

## The default allowlist

`DEFAULT_ALLOWED_TOOLS` covers the built-in file/search/web tools plus most of
the brain CLI's own MCP tools — `brain_search`, `brain_context`, `brain_read`,
`brain_list`, `brain_graph`, `brain_add` and `brain_update`, as
`mcp__brain__*`. The write-capable two are in there deliberately: `Write` and
`Edit` are already allowed, so an agent that wanted to change the repo never
needed `brain_add` to do it, and routing the change through the brain tools is
what keeps frontmatter and the search index correct.

`brain_archive` is the exception — it moves files between directories, so it
stays behind an approval card.

The prefix assumes the brain repo registers the MCP server under the key
`brain` in its `.mcp.json` (what `brain setup` writes). A different key means a
different prefix and these entries stop matching, so the tools prompt — the
safe direction to fail.

## Write serialization: PreToolUse, not canUseTool

The Agent SDK **auto-allows** tools listed in `allowedTools` without invoking
the `canUseTool` permission callback (it even warns
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). A write lock living in the permission
path would therefore never engage for allowlisted mutating tools. The lock
here is acquired in an awaited **PreToolUse hook**, which fires for every tool
execution regardless of allowlisting — verified against the real SDK at
runtime, not inferred from types.

The mutating set is `Bash`, `Edit`, `Write`, `NotebookEdit` and all three brain
writers (`brain_add`, `brain_update`, `brain_archive`) — including the one that
is not auto-allowed, because membership there is about serialization, not
permission.

## The `brain-kit` MCP server

The backend registers an in-process MCP server named `brain-kit`, so its tools
surface to the model as `mcp__brain-ui__*`:

- `mcp__brain-ui__ask_user` — routes a structured question to the host's
  `bridge.askUser` and blocks the turn until the human answers.
- `mcp__brain-ui__get_current_location` — mirrors the ask-user bridge for
  browser geolocation: the host emits a `location_request` to the client, the
  browser answers, and the fix is returned to the model.

Each is appended to the allowlist only when the host actually provides its
bridge, so a host without them never advertises the tool at all.

## Capabilities

`resume`, `permissions`, `thinking`, `attachments`, `askUser`,
`costReporting`, and `concurrentSessions` are all `true` — each turn is its
own `query()` subprocess, so turns on *different* sessions run in parallel and
busy-ness is per session. `followUp` is `false`: the SDK has no mid-turn
message injection, so hosts queue follow-ups as the session's next turn.

## History

`getHistory` reads the Claude Code session JSONL under the brain repo and
normalizes it into the protocol's `SessionHistoryMessage[]`, threading tool
results back onto their assistant tool calls.

## Testing

`bun test` — no live model calls. The backend is exercised through an injected
`queryFn` plus the shared cross-backend contract suite (terminal-frame
invariants, capability honesty, permission gating).
