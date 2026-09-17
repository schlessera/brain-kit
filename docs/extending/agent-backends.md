# Extending: agent backends

The backend seam has two layers. `AgentBackend` is the running conversation
engine. `BackendModule` is the self-describing package boundary that validates
profiles, declares its settings needs, optionally owns model discovery, and
constructs that engine. Both live in `@schlessera/brain-ui-sdk/server`, not in
`@schlessera/brain`: this is a chat-UI seam, distinct from the CLI-oriented
[`AgentRunner`](agent-runners.md) seam in core.

The env-driven built-in path activates only `claude` or `pi`. This is a fixed
first-party table, not a plugin loader: `AGENT_BACKEND` never accepts package,
file, or URL specifiers. A third-party module is imported by the deployment's
own bin and passed by value, as shown below.

Two first-party implementations are the reference material:

- `packages/ui-backend-claude` — `@schlessera/brain-backend-claude`, on the
  Claude Agent SDK. Session persistence, tool execution, and cost reporting
  are the SDK's; the package maps its streaming output onto the wire protocol
  and adds profiles, model discovery, and the ask-user / location / mask
  bridge tools.
- `packages/ui-backend-pi` — `@schlessera/brain-backend-pi`, on the upstream
  pi coding-agent SDK, with its own curated brain tool set
  (`packages/ui-backend-pi/src/tools.ts`) and risk classes.

## The two interfaces

Every backend package exports one descriptor with exactly this top-level
shape:

```ts
export interface BackendModule {
  id: string;
  resolveFromEnv(
    context: BackendModuleContext,
  ): BackendModuleResolution | Promise<BackendModuleResolution>;
  profileSchema: BackendProfileSchema;
  settingsHooks: BackendSettingsHooks;
  modelSource?(context: BackendModuleContext): BackendModelSource | null;
}
```

- `profileSchema` owns JSON parsing, required fields, reserved ids, and
  duplicates. It returns typed `BackendProfileError`s; the host
  raises `BackendProfileConfigError` while retaining those typed details. Its
  context also carries raw inactive rosters for lenient cross-roster collision
  checks; inspecting that data must never require or strictly validate the
  inactive backend.
- `settingsHooks` declares which of the host's hidden/default/OpenRouter/
  thinking/billing readers the backend consumes. A descriptor receives only
  those readers. Claude asks for OpenRouter models; pi asks for thinking
  overrides; each owns its own billing classifier.
- `modelSource` is optional. The Claude descriptor uses it for Anthropic model
  discovery; pi has no discovery source.
- `resolveFromEnv` returns `{ ok: true, value }` with the `AgentBackend` and its
  registry hooks, or `{ ok: false, error }`. Construction errors therefore stay
  explicit without teaching the host a backend's options.

Use `defineBackendModule()` for inference and excess-property checking. The
interface is `@experimental` until 1.0.

The descriptor ultimately constructs the runtime interface:

From `@schlessera/brain-ui-sdk/server` (`packages/ui-sdk/src/server/backend.ts`):

```ts
export interface AgentBackend {
  /** Stable identity, e.g. "pi" | "claude". Persisted per session (backend_id). */
  id: string;
  capabilities: BackendCapabilities;
  /** Model/endpoint profiles this backend can run. Never exposes keys. */
  listProfiles(): ProviderInfo[] | Promise<ProviderInfo[]>;
  startTurn(req: StartTurnRequest): Promise<void>;
  /** Inject a user message into a RUNNING turn (only when capabilities.followUp). */
  followUp?(req: FollowUpRequest): Promise<void>;
  /** Sessions this backend owns (its own transcript store). */
  listSessions(): Promise<ChatSession[]>;
  /** Normalized-at-read history; backends own raw transcripts. */
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
}
```

`BackendCapabilities` is a complete, honest boolean set — `resume`,
`permissions`, `thinking`, `attachments`, `askUser`, `costReporting`,
`concurrentSessions`, `followUp`. The host and the client degrade against it;
never advertise a capability you do not implement (a backend that claims
`permissions: true` over a no-op gate lets mutations execute unapproved —
that is the failure mode this flag guards).

Backends own their transcripts. `listSessions()` / `getHistory()` read from
the backend's own store (the SDK ships a shared JSONL implementation:
`createTranscriptStore` in `packages/ui-sdk/src/server/transcript-store.ts`),
normalizing to `SessionHistoryMessage` at read time.

## Turn lifecycle

`startTurn(req)` receives the prompt, optional attachments, an optional
`sessionId` (resume — requires `capabilities.resume`), an optional `profileId`
(only honored on new sessions), a host-owned `AbortSignal`, the
`BackendBridge`, and an advisory `ClientEnvironment`. The contract, asserted
by the cross-backend suite:

- **Emit `session_info` first.** As soon as the session identity is known,
  before any content frames for a new session. Every session-scoped frame
  after that carries `sessionId`.
- **Stream** via `bridge.emit()`: `text_delta`, `thinking_delta`,
  `tool_use_start` / `tool_input_delta` / `tool_use_complete` /
  `tool_result`, and `status` frames.
- **End with exactly one terminal `result` frame** once a session identity
  exists (`isError` is required; `outcome: "success" | "error" | "cancelled"`
  is optional on the wire for compatibility, but new backends should always
  set it; `durationMs`, `numTurns`, optional `costUsd` — absent means
  unknown, `0` means actually free) and only then resolve the `startTurn`
  promise. A failure before any session identity exists ends with a bare
  `error` frame instead of a `result`.
- **Abort:** the host owns the `AbortController` (user cancel + host timeout).
  On abort, stop work, emit `status: "cancelled"` then the terminal `result`
  with `outcome: "cancelled"`, and RESOLVE. Cancellation before a session
  identity exists may end with a bare `error` frame instead — the contract
  suite allows it.
- **Runtime failures** once streaming has begun (agent crashed, provider
  unreachable) are emitted as an `error` frame and the promise RESOLVES — the
  wire consumer needs the frame either way. Caller errors REJECT: a turn on a
  session that is already running (`BackendBusyError`), an unknown
  `profileId`, or resume without `capabilities.resume`
  (`BackendRequestError`). A setup failure before streaming starts (e.g. the
  pi backend's session acquisition) may also reject; the host converts any
  rejection into a turn error toward the client, so nothing is lost — but
  prefer the frame-then-resolve shape wherever a session already exists.
- **Concurrency is per session.** With `capabilities.concurrentSessions`,
  turns on different sessions run in parallel (the host enforces its own
  deployment cap); resuming a session that is already running rejects with
  `BackendBusyError`. Without it, the backend is a single-turn instance and
  the host serializes.
- **Follow-up:** with `capabilities.followUp`, `followUp()` delivers mid-turn
  user messages into the running turn (frames keep flowing through the
  original turn's bridge). Without it, the host queues the message as the
  session's next turn (`status: "queued"` on the wire).
- **Shared-repo safety:** serialize MUTATING tool executions across all your
  sessions through a `WriteLock` (`createWriteLock` in
  `packages/ui-sdk/src/server/write-lock.ts`) — two agents editing one
  working tree must never interleave writes or git operations. The Claude
  backend acquires it in a `PreToolUse` hook; wherever you hook it, it must
  actually sit on the execution path of every mutating tool.

`buildSystemPromptAppend` (`packages/ui-sdk/src/server/system-prompt.ts`)
builds the shared brain-ui system-prompt block; backends that can vary their
system prompt per turn feed it the advisory `req.client` environment.

## The bridge

`BackendBridge` is the host plumbing handed to the backend for one turn:

```ts
export interface BackendBridge {
  emit(msg: ServerMessage): void;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  askUser?(requestId: string, questions: AskUserQuestion[]): Promise<AskUserResult>;
  getLocation?(options?: GeoRequestOptions): Promise<LocationFix>;
  requestMask?(imagePath: string, instruction?: string): Promise<Uint8Array>;
}
```

- `requestPermission` is the tool gate: the host renders an approval card,
  and resolves with `{ behavior: "allow", updatedInput? }` or
  `{ behavior: "deny", message }`. The host owns the per-turn timeout.
- The optional members signal HOST capability — gate your ask-user /
  location / mask tooling on their presence, either at registration (the
  Claude backend) or at execution time (the pi backend always lists
  `ask_user` and returns an informative tool error when the host lacks it).
- `askUser` / `getLocation` / `requestMask` resolve when the user answers
  and REJECT on cancel or disconnect — translate a rejection into the
  agent-appropriate tool error; never let it crash the turn.
  `requestPermission` never rejects: cancellation and disconnect surface as a
  deny decision.

**`turnId` is host-owned.** The host mints a `turnId` per turn, stamps it onto
every frame the bridge emits (`packages/ui-server/src/ws/bridge.ts`), and its
dispatch layer verifies the client's echo before resolving a pending
approval / ask-user / location / mask request — mandatory for clients that
declare protocol revision 3, tolerated absent for older revisions
(`packages/ui-sdk/src/protocol.ts`). A backend neither mints nor echoes
`turnId` — its obligation is simply to route every interactive round-trip
through the bridge so the correlation holds.

## How ui-server loads first-party modules

`@schlessera/brain-ui-server` keeps one hardcoded specifier table for the two
optional first-party peers. It dynamically imports the selected entries, checks
their `backendModule` exports structurally, then iterates the descriptors. The
registry does not call `createClaudeBackend`, `createPiBackend`, model discovery,
credential probes, or backend profile parsers itself.

At boot, `assertBackendResolvable` resolves and synchronously loads only active
backend packages. It runs each active backend-owned profile parser before
health reporting; backend construction and model discovery remain lazy. Raw
inactive rosters are handed to those parsers as collision data without loading
or strictly parsing the inactive package. Thus pi-primary deployments still
reject ids declared in the Claude roster, while malformed or incomplete
inactive Claude data contributes no ids and does not make pi depend on Claude.
Only a module-not-found error naming an active package maps to the actionable
install hint; a missing transitive dependency or throwing active module keeps
its original diagnostic.

Profile ids must be globally unique across the registry. Hidden profiles remain
resolvable for pinned sessions. A null/empty stored backend id is a legacy
session and uses the default; an unknown non-empty stored id fails explicitly.

## Pass a third-party backend by value

There is no registration step and no environment-based package loading. Import
the descriptor in your deployment bin, resolve it from deployment-owned values,
put its backend value in a static registry, and inject that registry into the
app:

```ts
import { backendModule as acmeModule } from "@acme/brain-backend-acme";
import {
  createApp,
  createStaticBackendRegistry,
} from "@schlessera/brain-ui-server";

const parsed = acmeModule.profileSchema.parse(
  process.env.BRAIN_UI_ACME_PROFILES ?? null,
  { occupiedProfiles: [], inactiveRosters: [] },
);
if (!parsed.ok) throw new Error(parsed.errors[0]?.message);

const base = {
  brainPath: process.env.BRAIN_PATH ?? "/data/brain",
  config: {},
  profiles: parsed.profiles,
  confirmBashPatterns: null,
  settings: {
    ...(acmeModule.settingsHooks.hiddenModelIds
      ? { getHiddenModelIds: () => [] }
      : {}),
    ...(acmeModule.settingsHooks.defaultModelId
      ? { getDefaultModelId: () => process.env.BRAIN_UI_DEFAULT_MODEL ?? null }
      : {}),
    ...(acmeModule.settingsHooks.customOpenRouterModels
      ? { getCustomOpenRouterModels: () => [] }
      : {}),
    ...(acmeModule.settingsHooks.thinkingOverrides
      ? { getThinkingOverrides: () => ({}) }
      : {}),
    ...(acmeModule.settingsHooks.billingOverrides
      ? { getBillingOverrides: () => ({}) }
      : {}),
  },
};
const modelSource = acmeModule.modelSource?.(base) ?? null;
const resolved = await acmeModule.resolveFromEnv({
  ...base,
  ...(modelSource ? { modelSource } : {}),
});
if (!resolved.ok) throw resolved.error;

const registry = createStaticBackendRegistry(
  [resolved.value],
  resolved.value.backend.id,
  { modelSource },
);
const app = createApp({ registry });
```

That import is ordinary application code: the package manager and deployment
own it, TypeScript sees it normally, and rollback is an image rollback. The
server never interprets an npm specifier from configuration.

## Naming and stability

- Publish as `brain-backend-<vendor>` under your own npm scope, matching the
  in-tree precedent (`brain-backend-claude`, `brain-backend-pi`).
- `BackendModule` and `AgentBackend` are **`@experimental` until 1.0**: breaking seam changes are
  minor-version events, announced in the CHANGELOG. The wire protocol itself
  (`packages/ui-sdk/src/protocol.ts`) is the harder contract — see
  [integration-contract.md](../integration-contract.md).
- The executable form of the turn contract is published as
  `runBackendContract` from `@schlessera/brain-ui-sdk/testing`. Supply a
  `BackendContractHarness` backed by your own fake runtime and inject your test
  runner's `{ describe, test, expect }`; the same assertions used by both
  first-party backends then run in your package.

## See also

- [README.md](README.md) — the seam meta-mechanism and the other chat-UI seams.
- [agent-runners.md](agent-runners.md) — the CLI-oriented agent seam in core.
- [../integration-contract.md](../integration-contract.md) — protocol revisions
  and stability guarantees.
