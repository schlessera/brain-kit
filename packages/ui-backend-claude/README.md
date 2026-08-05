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
| `profiles` | `DEFAULT_PROFILES` | Selectable inference profiles; first is the default. |
| `allowedTools` | `DEFAULT_ALLOWED_TOOLS` | Backend-wide allowlist; a profile's own `allowedTools` overrides it. |
| `writeLock` | fresh per-instance lock | Serializes mutating tool executions across all sessions of this backend. Inject a shared one to coordinate with other in-process writers. |

## Write serialization: PreToolUse, not canUseTool

The Agent SDK **auto-allows** tools listed in `allowedTools` without invoking
the `canUseTool` permission callback (it even warns
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). A write lock living in the permission
path would therefore never engage for allowlisted mutating tools. The lock
here is acquired in an awaited **PreToolUse hook**, which fires for every tool
execution regardless of allowlisting — verified against the real SDK at
runtime, not inferred from types.

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
