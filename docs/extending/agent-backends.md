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
  probeRuntime?(context: BackendModuleContext): Promise<BackendRuntimeReport>;
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
  those readers. Claude asks for OpenRouter models; both first-party backends
  consume thinking overrides and own their billing classifiers.
- `modelSource` is optional. The Claude descriptor uses it for Anthropic model
  discovery; pi has no discovery source.
- `probeRuntime` is optional and asynchronous. It checks the runtime a turn
  would spawn, returning its `BackendRuntimeReport` or rejecting to refuse
  startup. `createApp` awaits it before opening application resources. Migrate
  synchronous descriptors to `async probeRuntime(context)`; no synchronous
  compatibility signature is retained. A host injecting its own registry
  owns any required runtime check before `await createApp({ registry })`.
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
(selects the model on new sessions and resolves its effort default on resumes),
optional `thinkingLevel` for this turn only, a host-owned `AbortSignal`, the
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
- **Effort:** resolve a per-turn `thinkingLevel` ahead of the current profile
  default on every turn, including a resume. Advertise supported levels in
  `ProviderInfo.supportedThinkingLevels` and downgrade unsupported requests
  to the nearest lower supported level. Report `effectiveThinkingLevel` only
  when the runtime confirms it; option assembly alone is not confirmation.
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

### An enforced allowlist (`@experimental`)

A tool allowlist is normally an *auto-allow* list: tools on it run without a
card, tools off it raise one. `req.enforceAllowedTools` asks for the stronger
reading — the allowlist is a **boundary**, and nothing may admit a tool absent
from it without a permission decision actually being taken. It exists because a
deployment that narrows the list for one kind of turn (a voice posture, an
unattended profile) otherwise gets a list that several shortcuts quietly
re-admit tools past.

Every conforming backend must enforce a requested restricted posture or reject
it with `BackendRequestError` before runtime acquisition or execution. Silent
ignoring is forbidden. This is a mandatory pre-1.0 conformance baseline,
recorded in [backend-conformance.md](../decisions/backend-conformance.md), not a
general freeze of the experimental seam. The optional request fields do not
enable restrictions on ordinary turns.

A backend enforcing it must:

- **override its runtime's own auto-approval, not merely stop adding to it.**
  Withholding the backend's own shortcuts is not enough if the runtime admits
  the call first, and runtimes do. Three measured examples from the Claude SDK,
  all with an empty `allowedTools`: its safe-command classifier runs `echo hi`
  without ever consulting `canUseTool` (while `touch <path>` does go through
  it — the difference is the command's shape, so one probe command proves
  nothing about another); a built-in tool can run with no callback at all
  (`ToolSearch`, twice); and a `PreToolUse` hook in the project settings it
  loads can return `permissionDecision: "allow"` outright — from a file in the
  brain repo, which the turn can write. The Claude backend answers `ask` from a
  PreToolUse hook for every off-list tool, which overrides all three. These
  are measured against the runtime `MEASURED_RUNTIME` names
  (`@schlessera/brain-backend-claude`), and `scripts/measure-claude-runtime.ts`
  re-measures them, keyless, against a scripted model. Whatever the equivalent
  is in your runtime, find it before claiming the field is honoured — and probe
  with more than one tool and one command shape.
- not let its own input-rewrite hooks grant a tool the allowlist leaves out.
  The Claude backend's hooks return a `PreToolUse` `permissionDecision:
  "allow"` because that historically looked necessary for `updatedInput` to
  apply; it is not, so under enforcement they rewrite without granting and the
  call falls through to `canUseTool`. The rewrite is the point; the grant was a
  side effect.
- set `outsideEnforcedAllowlist: true` on every `PermissionRequest` it raises
  for such a tool, so the host knows not to answer from — or add to — its
  remembered "always allow" grants. A grant belongs to the posture it was given
  under, in both directions.

A turn that does not declare it behaves exactly as it always has. A backend
that cannot enforce it must reject the restricted turn before starting work.

`enforceAllowedTools` does not itself deny anything. It removes the ways a
decision gets skipped; what happens to a request that reaches the host is the
host's own policy.

### A turn with no grant surface (`@experimental`)

`req.noGrantSurface` says the turn has nothing that could answer an approval
card — a spoken conversation, an unattended run. A backend that honours it
resolves such a request `{ behavior: "deny", message }` itself instead of
putting it to the bridge, because a card raised in that turn is a card nobody
can answer and it parks until the turn budget expires. The message names the
tool: the model has to act on it, and a listener has to be able to hear it read
out.

It is a separate field from `enforceAllowedTools` because the two facts are
separate — a turn may enforce its allowlist and still have a human able to
answer — but it is only valid together with it. Enforcement is what makes the
decision happen at all: without it, a runtime's own shortcuts can admit a tool
before the backend's callback is ever consulted, and there is then no request
to refuse.

**Declared without `enforceAllowedTools`, the turn is refused.** Both shipped
backends call `assertTurnPosture(req)` first in `startTurn`, which rejects
`noGrantSurface` without `enforceAllowedTools: true` with a
`BackendRequestError` before anything is emitted. The alternatives were
weighed in #173: documenting or warning would leave a caller able to build a
posture that is decoration, and turning enforcement on implicitly would make a
turn that said only "nobody can answer" also narrow what the model may reach,
which is a different statement from the one the caller made. The pi backend
refuses too, although its runtime has none of the shortcuts that make the
unpaired declaration unreachable on Claude — every pi tool call passes its
gate — so that one rule describes the declaration on either backend, and a
posture that works on one does not start failing when moved to the other. A
third-party backend must reject this invalid combination too; it can call the
same function.

A backend enforcing it must:

- refuse **both** request kinds. Removing a tool from the allowlist is not what
  raises most requests: a shell command matching a confirm pattern raises a
  `command` request for a tool that IS allowlisted, and on the Claude backend
  that happens in a `PreToolUse` hook, before permission evaluation. A rule
  written only for the tool-grant path misses exactly the calls this exists
  for. Both backends here refuse in the shared `requestToolPermission`, which
  is the one place both kinds pass through.
- not offer the turn a capability that needs a human surface. The Claude
  backend appends its bridge tools to the turn's allowlist when the host offers
  the handler; `request_image_mask` opens an editor and then blocks on a region
  someone has to paint, so it is withheld from such a turn rather than offered
  and blocked on.
- report the refusal on the activity side channel
  (`{ kind: "permission_denied", toolUseId, requestKind, reason }`). The host
  records a user's denial as the card is answered; a refusal that never reached
  the host would otherwise show up in the activity record as a call that
  errored rather than one that was denied.

## Confirmation-pattern configuration

Both shipped backends compile `confirmBashPatterns` through the SDK's
`compileConfirmPatterns` during construction, before starting a runtime or
executing tools. Missing configuration uses the first-party bundled confirmation policy;
an explicit `[]` disables confirmation. Invalid entries are reported and
skipped when at least one valid regex remains, preserving the valid entries'
matching order and effects. A nonempty list with no valid regex throws an
actionable configuration error instead of becoming an empty policy.

The server passes regex sources from `BRAIN_UI_CONFIRM_BASH` through this same
compiler. Its existing malformed-JSON and structural-entry fallback still
uses defaults; a syntactically valid JSON list such as `["("]` fails backend
initialization. See [the ruling](../decisions/confirm-patterns.md).

## The public permission toolkit

Import `decideToolPermission`, `createToolPermissionRequest`,
`requestToolPermission`, `checkEditedApproval` and `compileConfirmPatterns`
from `@schlessera/brain-ui-sdk/server`. Their input/output types are exported
from the same path: `ToolPermissionDecisionInput`, `ToolPermissionApproval`,
`CreateToolPermissionRequestInput`, `RequestToolPermissionOptions`,
`EditedApprovalCheckInput`, `ConfirmPattern`, `ConfirmPatternSource` and
`CompiledConfirmPattern`, alongside the bridge and permission types. The
[inventory and ruling](../decisions/backend-authoring-toolkit.md) distinguish
this authoring API from first-party policies.

Compile the configured confirmation sources before starting your runtime.
Decide before executing a call, ask the host when necessary, and apply only an
allowed, checked input. A minimal binding looks like this:

```ts
import {
  checkEditedApproval, createToolPermissionRequest, decideToolPermission,
  requestToolPermission,
  type BackendBridge, type PermissionDecision, type ToolPermissionDecisionInput,
} from "@schlessera/brain-ui-sdk/server";

async function authorizeCall(
  bridge: BackendBridge | null,
  policy: ToolPermissionDecisionInput & { input: Record<string, unknown> },
  toolUseId: string,
  noGrantSurface: boolean,
  outsideEnforcedAllowlist: boolean,
): Promise<PermissionDecision> {
  const approval = decideToolPermission(policy);
  if (!approval) return { behavior: "allow" };
  const decision = await requestToolPermission(bridge, createToolPermissionRequest({
    toolUseId, toolName: policy.toolName, input: policy.input,
    description: approval.reason, approval, outsideEnforcedAllowlist,
  }), { noGrantSurface });
  if (decision.behavior === "deny") return decision;
  if (decision.updatedInput !== undefined) {
    const message = checkEditedApproval({
      ...policy, originalInput: policy.input, editedInput: decision.updatedInput,
    });
    if (message) return { behavior: "deny", message };
  }
  return decision;
}
```

The caller dispatches only after this resolves `allow`, using
`decision.updatedInput ?? originalInput`. Use the returned snapshot for both
checking and application; do not read the bridge's original edit again.
A missing bridge denies. `noGrantSurface` denies both request kinds without
asking. An edit that introduces a new destructive command or changes the
archive target is refused; an unchanged confirmed command or a safe edit may
pass. An own `__proto__` input key is refused. Translate bridge rejections into
your runtime's tool error. These are behavioral guarantees, not just signatures.

The adapter computes `outsideEnforcedAllowlist` from the turn's enforced
allowlist, including when its runtime callback uses a different allowlist to
force an approval. `assertTurnPosture(req)` validates the paired restricted-turn
fields before starting a runtime; the adapter remains responsible for honoring
them at every execution path. Run the published backend contract suite against
your runtime binding.

The toolkit stays experimental until 1.0. Its deliberate public operations,
reachable types and documented behavior become stable then. Confirmation
source formats and explicit-empty behavior are supported; bundled default
entries may evolve with documented user-visible changes, while preserving the
permission guarantees. No default-policy update excuses a breaking behavior.

Bundled lists, command-inspection helpers and subprocess policy tables moved
to explicitly unsupported `/internal` paths. External authors configure their
own policy through the public formats. See the
[migration inventory](../decisions/backend-authoring-toolkit.md#inventory) for
the removed names and their first-party destinations. Subscription-auth
mapping and instruction helpers remain public under the wire contract.

## The bridge

`BackendBridge` is the host plumbing handed to the backend for one turn:

```ts
export interface BackendBridge {
  emit(msg: ServerMessage): void;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  askUser?(requestId: string, questions: AskUserQuestion[]): Promise<AskUserResult>;
  askUserList?(requestId: string, request: AskUserListSpec): Promise<AskUserListResult>;
  getLocation?(options?: GeoRequestOptions): Promise<LocationFix>;
  requestMask?(imagePath: string, instruction?: string): Promise<Uint8Array>;
}
```

- `requestPermission` is the tool gate: the host renders an approval card,
  and resolves with `{ behavior: "allow", updatedInput? }` or
  `{ behavior: "deny", message }`. A backend must not apply an
  `updatedInput` unchecked: the card confirmed the input it showed, so both
  shipped backends re-check the edit with `checkEditedApproval` first and
  refuse one that needs a confirmation the card did not show. The host owns
  the per-turn timeout. A
  request carrying `outsideEnforcedAllowlist` is one the host must decide on
  its own merits — see the enforced-allowlist section above.
- The optional members signal HOST capability — gate your ask-user /
  location / mask tooling on their presence, either at registration (the
  Claude backend) or at execution time (the pi backend always lists
  `ask_user` and returns an informative tool error when the host lacks it).
- `askUserList` carries `ask_user_list` (one scale over up to thirty items).
  It needs someone to read the card, so both shipped backends withhold it
  from a turn that declares `noGrantSurface`, as they do the mask editor.
- `askUser` / `askUserList` / `getLocation` / `requestMask` resolve when the user answers
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
const app = await createApp({ registry });
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
- The harness's required `permission(scenario)` drives the adapter's actual
  tool path and observes runtime starts, attempts and tool-body effects for
  off-list mutation, runtime-shortcut and allowlisted confirmation scenarios.
  Restrictions are tested without an optional capability or harness opt-in.
  Unsupported restricted turns may safely reject before acquisition, frames
  or effects. First-party adapters additionally prove actual enforcement.
- Run `runBackendModuleContract` from the same testing entry with your actual
  descriptor, valid nonempty profile JSON, expected profile ids and an isolated
  construction context. It checks `defineBackendModule`, parsing, resolution,
  confirmation-pattern defaults, invalid JSON and occupied-id collisions.

## See also

- [README.md](README.md) — the seam meta-mechanism and the other chat-UI seams.
- [agent-runners.md](agent-runners.md) — the CLI-oriented agent seam in core.
- [../integration-contract.md](../integration-contract.md) — protocol revisions
  and stability guarantees.
