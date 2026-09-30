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
| `confirmBashPatterns` | shared `DEFAULT_CONFIRM_BASH_PATTERNS` | Regex sources or `{ pattern, effect }` entries; matching Bash commands raise a confirmation card. `[]` disables confirmation. A nonempty list with no valid regex rejects construction; mixed lists report invalid entries and retain valid patterns and effects. |
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

`brain_archive` is the exception, and the reason is VISIBILITY, not the file
move it also does: an archived document drops out of search, briefings and
context assembly, so a silent archive shows up later as holes in output nobody
can account for. It stays behind an approval card.

An approval that carries an edited input (`updatedInput`) is re-checked
before it is applied, the same way on both backends (#145). The shared
`checkEditedApproval` runs the confirm policy again on the edited input: an
edit that needs no confirmation, or only the confirmations the card already
showed (the same command, the same archived document), is applied; one
that needs a confirmation the card did not show is refused whole, and the model
is told why. The write lock is taken on the edited input's key. On the PreToolUse
path the edit is returned as `updatedInput` with no `permissionDecision`, which
the runtime applies without a grant (measured against the runtime
`MEASURED_RUNTIME` names, by `scripts/measure-claude-runtime.ts`), so a tool left off `allowedTools`
still goes on to `canUseTool`. The rtk rewrite leaves a confirmed command
alone, because parallel PreToolUse hooks each see the original input and the
last to finish wins, so a rewrite could land over the edit.

That argument reaches one input shape of an auto-allowed tool, too.
`brain_update` takes the same `status` field, so `status: "archived"` is the
identical visibility change — it raises a per-use confirmation from the
PreToolUse hook (never a grantable "always allow brain_update"). Every other
update — no `status`, or `"active"`/`"draft"` — runs unprompted, because a card
on every document edit is the noise that gets the mechanism switched off.

The prefix assumes the brain repo registers the MCP server under the key
`brain` in its `.mcp.json` (what `brain setup` writes). A different key means a
different prefix and these entries stop matching, so the tools prompt — the
safe direction to fail.


### The voice posture

`VOICE_ALLOWED_TOOLS` is the narrower set a spoken turn runs under: the read-only
brain tools, `brain_add` and `brain_update`, `Read`/`Glob`/`Grep`,
`WebSearch`/`WebFetch`, and the bridge tools except the mask editor. `Bash`,
the raw file writes, `Agent`, `Skill`, `LSP` and `brain_archive` are left out.
The reasons are in the source and in `docs/decisions/voice-permission.md`.

Select it like any allowlist, through a profile's `allowedTools` or the
backend's. It is a boundary only when the turn declares `enforceAllowedTools`,
and a voice turn also declares `noGrantSurface`. With both declared, a tool
the list leaves out is denied where it is raised, and no card is put up for
it.

## Write serialization: PreToolUse, not canUseTool

The Agent SDK **auto-allows** tools listed in `allowedTools` without invoking
the `canUseTool` permission callback (it even warns
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). A write lock living in the permission
path would therefore never engage for allowlisted mutating tools. The lock
here is acquired in an awaited **PreToolUse hook**, which fires for every tool
execution regardless of allowlisting — measured against the runtime
`MEASURED_RUNTIME` names (the `pretooluse-awaited-when-allowlisted` case of
`scripts/measure-claude-runtime.ts`), not inferred from types.

The mutating set is `Bash`, `Edit`, `Write`, `NotebookEdit` and all three brain
writers (`brain_add`, `brain_update`, `brain_archive`) — including the one that
is not auto-allowed, because membership there is about serialization, not
permission.

## The `brain-kit` MCP server

The backend registers an in-process MCP server named `brain-kit`, so its tools
surface to the model as `mcp__brain-ui__*`:

- `mcp__brain-ui__ask_user` — routes a structured question to the host's
  `bridge.askUser` and blocks the turn until the human answers.
- `mcp__brain-ui__ask_user_list` — one scale over a list of up to thirty
  items, answered in one card, through `bridge.askUserList`. Withheld from a
  turn that declares `noGrantSurface`, like the mask editor.
- `mcp__brain-ui__get_current_location` — mirrors the ask-user bridge for
  browser geolocation: the host emits a `location_request` to the client, the
  browser answers, and the fix is returned to the model.
- `mcp__brain-ui__show_block` — renders one of the kit's answer blocks (a
  comparison table, stat tiles, a trend chart, …) inline in the answer. It
  needs nothing from the host, so it is always registered and auto-allowed.

Each bridge tool is appended to the allowlist only when the host actually provides its
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

## Environment

Every variable this package reads, and what happens when it is unset. This
table is generated from the package's env chokepoint — the single file allowed
to touch `process.env`.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | API key for the Anthropic Models API (model discovery), used when no subscription token is set. Never reaches a chat turn on a profile without its own credential: those run on the subscription. | — |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible endpoint inherited by profiles that declare no baseUrl of their own. Read to classify a run's pricing route; also passed through to the agent subprocess. | — |
| `BRAIN_UI_EXEC_KILLER` | Absolute path to an authorised helper that cancels the wrapped Claude Code process group, invoked as `<killer> <pgid> <TERM\|KILL\|INT>`. Needed only when the wrapper changes uid: signalling then fails with EPERM however the group is arranged, and an aborted turn would keep running. | (none — signal the group directly) |
| `BRAIN_UI_EXEC_WRAPPER` | Absolute path to an executable the Claude Code subprocess is launched through, as `<wrapper> <program> <args…>`. Lets a host run the agent as another user without this package knowing how. It is an argv[0], never a command line: no shell parses it. Unset, the SDK spawns exactly as it did before. | (none — let the SDK spawn directly) |
| `BRAIN_UI_REVERSE_GEOCODE` | "0"/"off"/"false" disables reverse geocoding in the location tool (raw coordinates only). | enabled |
| `BRAIN_UI_SUBPROCESS_ENV_EXTRA` | Comma-separated environment variable names to admit to the Claude Code subprocess when an operator integration needs a variable outside the shipped agent allowlist. Names are trimmed; malformed entries are ignored; the control variable itself is never forwarded. | (empty) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token: authenticates chat turns on every profile without its own credential, and model discovery. Wins over ANTHROPIC_API_KEY. | — |
| `NOMINATIM_URL` | Reverse-geocoding endpoint. | https://nominatim.openstreetmap.org |
| `NOMINATIM_USER_AGENT` | Identifying User-Agent for Nominatim (usage-policy requirement). | brain-kit-ui/1.0 |

Reads whose variable *name* is configuration rather than code:

| Name comes from | What the value is used for |
| --- | --- |
| filtered environment snapshot | The Claude Code subprocess receives the SDK agent allowlist, the selected profile's declared credential names, and operator extras (with profile overrides merged on top). |
| inference profile `authTokenEnv` / `apiKeyEnv` | Credential for a declared inference profile, read at query time under whatever name the profile declares (also drives profile availability). |

Generated from `packages/ui-backend-claude/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->

## Asynchronous runtime probe

`probeClaudeRuntime(options): Promise<BackendRuntimeReport>` and the module's
`probeRuntime(context)` are asynchronous. Await the probe and catch
`ClaudeRuntimeUnavailableError` from the rejected promise. It still executes
only `--version` of the SDK-selected binary with the turn's wrapper,
environment and working directory. A timeout rejects even if a version was
printed. The five-second deadline starts cancellation while the child is
running; settlement includes at most 250 ms of cleanup. Failed or unconfirmed
cleanup is included in the refusal diagnostic. The app factory awaits this
required check before opening its resources.
