# State, config and renderer architecture for `ui-kit` / `ui-react`

Status: proposal. Written against `main` @ `c6f7a6e` (v0.35.0). Binding inputs:
`.plan/DECISIONS.md` (D1–D5), `AGENTS.md`, `ROADMAP.md` "What binds future
work", `docs/integration-contract.md`, `docs/extending/README.md`.

All paths in this document are repo-relative. The leakage gate
(`scripts/check-leakage.ts`) scans `.plan/` including untracked files.

---

## 0. TL;DR

**Recommendation: (b) as the packaging rule, (a) as the plumbing underneath.**

- `packages/ui-kit` is 100% prop-driven. No zustand, no `fetch`, no
  `uiConfig`, no `window.location`, no `localStorage`. A lint gate enforces it.
- `packages/ui-react` keeps zustand but the stores become **instances created
  by a factory and reached through one React context**. The hook *names and
  call signatures do not change*, so the ~250 `useXStore(selector)` call sites
  across ~60 files are untouched.
- A **default root** (an eagerly-created module-level instance, used when no
  provider is mounted) keeps every current export of
  `@schlessera/brain-ui-react` working byte-for-byte. The change is additive:
  a minor, not a major, not a `CONTRACT:` commit.
- The SDK tool-renderer registry becomes instantiable the same way
  (`createToolRendererRegistry()` + a module default), because Storybook docs
  mode mounts several stories at once and a global registry with an idempotent
  `registered` flag cannot serve two of them.
- D3 gets **one zod contract object per in-chat component**, React-free so the
  server can import it: `input` feeds `z.toJSONSchema()` for the LLM,
  `payload` feeds `z.infer` for the component's props, and a typed `bind()`
  makes drift a compile error. **No `PROTOCOL_REV` bump is needed** — the wire
  already carries the payload as a JSON string in `ServerToolResult.output`.

---

## 1. Target shape

### 1.1 What is actually broken

Four symptoms, and they do not all have the same cause:

| Symptom | Cause |
|---|---|
| Stories/tests must `setState()` on a real global | stores are module singletons |
| Tests leak into each other | *same* singleton across one `bun test` process |
| Two embedders on one page impossible | same, plus `uiConfig` / `apiBase()` |
| A component's dependencies are invisible | components import stores directly |

Symptoms 1, 2 and 3 are fixed by *instancing*. Symptom 4 is fixed by
*not importing stores from a presentational component* — a different move.
Any proposal that only does one of the two leaves half the pain in place, which
is why the answer is layered rather than a single lettered option.

### 1.2 The recommendation

**`ui-kit`: store-free, network-free, config-free.** Everything it renders
arrives as a prop; everything it causes leaves as a callback prop.

**`ui-react`: one provider, one root object, instanced stores.**

```ts
// packages/ui-react/src/root.ts
export interface BrainUiRoot {
  readonly config: BrainUiConfig;      // mutable object, see §3
  readonly api: BrainApi;              // = typeof api, bound to this root's base URL
  readonly renderers: ToolRendererRegistry;
  readonly stores: BrainStores;
}

export interface BrainStores {
  chat: StoreApi<ChatState>;
  ui: StoreApi<UIState>;
  file: StoreApi<FileState>;
  graph: StoreApi<GraphState>;
  activity: StoreApi<ActivityState>;
  connection: StoreApi<ConnectionState>;
  provider: StoreApi<ProviderState>;
  mask: StoreApi<MaskState>;
  principal: StoreApi<PrincipalState>;
  share: StoreApi<ShareIntakeState>;
  voice: StoreApi<VoiceState>;
}

export interface BrainUiRootOptions {
  config?: Partial<BrainUiConfig>;
  /** Override the REST client — a fake in tests, a recorded fixture in stories. */
  api?: BrainApi;
  /**
   * Namespace for the three localStorage keys this root owns. Two roots on one
   * page MUST differ here or they fight over the active session id.
   */
  storagePrefix?: string;
}

export function createBrainUiRoot(options?: BrainUiRootOptions): BrainUiRoot;
```

```tsx
// packages/ui-react/src/root-context.tsx
const RootContext = createContext<BrainUiRoot | null>(null);

/**
 * The root every hook resolves to when no provider is mounted. Eager, so it is
 * exactly today's module-singleton behaviour and the module-scope `getState()`
 * escape hatches keep a target. Removed at 1.0 (see §5, S10).
 */
export const defaultRoot: BrainUiRoot = createBrainUiRoot();

export function BrainUiProvider({
  root,
  children,
}: { root?: BrainUiRoot; children: ReactNode }) {
  const owned = useRef<BrainUiRoot>();
  owned.current ??= root ?? createBrainUiRoot();
  return <RootContext value={root ?? owned.current}>{children}</RootContext>;
}

export function useBrainUiRoot(): BrainUiRoot {
  return useContext(RootContext) ?? defaultRoot;
}
```

**The move that keeps churn near zero.** Each store module keeps exporting a
hook with the same name and the same signature; only its body changes.

```ts
// packages/ui-react/src/stores/ui-store.ts — after
import { createStore, useStore, type StoreApi } from "zustand";

export function createUIStore(): StoreApi<UIState> {
  return createStore<UIState>((set) => ({ /* body unchanged */ }));
}

/**
 * Same name, same call signature as today: `useUIStore((s) => s.activeView)`
 * and `useUIStore(useShallow(sel))` both still work. `.getState()` /
 * `.setState()` are attached for module-scope callers and always address the
 * DEFAULT root — non-React code that must address a specific root takes the
 * store bundle as a parameter instead (see §5, S3).
 */
export const useUIStore = Object.assign(
  <T,>(selector: (state: UIState) => T): T =>
    useStore(useBrainUiRoot().stores.ui, selector),
  defaultRoot.stores.ui
);
```

Diffed call site count for this change: **zero in components.**
`useUIStore((s) => s.activeView)` is character-identical before and after.
`useShallow` composes as a selector wrapper, so `useChatStore(useShallow(...))`
in `tool-call-timeline.tsx` is also unchanged.

What *does* change: the ~55 `getState()` calls in 17 non-component files
(`hooks/use-websocket.ts`, `hooks/websocket-handlers/*`,
`components/chat/use-chat-commands.ts`, `hooks/use-vpn-status.ts`,
`hooks/use-share-intake.ts`, `hooks/use-hash-routes.ts`, `voice/asr-clients.ts`,
`voice/use-dictation.ts`, and the two stores that read each other). They keep
compiling on day one because of the attached statics, and are migrated to an
explicit `stores` parameter in a follow-up step — which is a readability win in
its own right, since `handleServerMessage` currently has invisible global
dependencies.

The three module-scope `registerDevHandle(...)` calls in `chat-store.ts:701`,
`graph-store.ts:354` and `activity-store.ts:284` move **inside** the factory,
and install `window.__chatStore` only for the default root. A second root does
not get debug handles; that is correct, not a gap.

### 1.3 Alternatives, and why they lose

**(b) alone — `ui-kit` prop-driven, `ui-react` keeps singletons.**
Cheapest by a wide margin and it is *half* of the recommendation. Rejected as
an end state because it fixes nothing inside `ui-react`: the 40-odd
store-coupled components there still cannot be tested in isolation, the
`bun test` process still shares one mutable graph store between
`render-smoke.test.tsx` cases (which is why `clearGraphSceneCache()` exists),
and a second embedder is still impossible. D5 names the stores explicitly; doing
(b) alone means doing the store work twice — once now to draw the kit boundary,
once later when the leakage finally bites. The migration cost of (a) on top of
(b) is genuinely small *because* the hook signature is preserved, so there is no
reason to defer it.

**(c) one root store with slices.** Rejected. `chat-store.ts` is 705 lines,
`file-store.ts` 392, `graph-store.ts` 358, `activity-store.ts` 288 + 164 helpers
+ 55 types. Merged, that is a ~2,000-line state object where every selector's
type spans the union and every `set` is a partial of everything. It also does
not merge cleanly: `graph-store.ts` keeps a module-level 40-entry LRU
`sceneCache` and monotonic request tokens; `activity-store.ts` keys spans by
run; `chat-store.ts` keys ~30 mutators by `ChatKey`. Slicing buys exactly one
thing over (a) — a single `setState` for tests — and costs a rewrite of every
store and every selector. It is churn without a payoff.

**(d) a different state library (Jotai/Valtio/`useSyncExternalStore` by hand).**
Rejected. zustand is already a dependency, the team knows it, and `createStore`
+ `useStore` is a first-class documented API for exactly this. Swapping
libraries would touch all 250 call sites for no architectural gain.

### 1.4 Does the public export surface break?

`packages/ui-react/src/index.ts` exports nine store hooks (`useChatStore`,
`useFileStore`, `useMaskStore`, `useUIStore`, `useGraphStore`,
`useConnectionStore`, `useProviderStore`, `useVoiceStore`, `useShareStore`),
the selectors `activeChat` / `anyStreaming` / `hasPendingShare`, the config
singleton pair `configureBrainUi` / `uiConfig`, `api`, and
`apiBase` / `getWsUrl` / `getBackendUrl`. The header comment says outright that
the shell reads the stores for its service-worker busy check and deep links.

With the default root, **none of those break**. Every one keeps its exact type
and behaviour when no provider is mounted; inside a provider, the hooks follow
the provider and the `.getState()` statics keep addressing the default root.
The only observable difference for an existing embedder is a documented one:
*module-scope `getState()` addresses the default root, not your provider's root.*

So: additive, minor, no `CONTRACT:` commit (none of CLI `--json`, MCP tool
names/schemas, `schema_version` or frontmatter is touched), no `PROTOCOL_REV`
bump. This matters more than usual here — all `@schlessera/brain-*` packages
version in lockstep, so a major on `ui-react` majors all thirteen packages, and
AGENTS.md records that an accidental major has already happened twice.

### 1.5 SSR and multi-root

There is no SSR today: `ui-server` serves a pre-built SPA it does not build,
and the shell lives in the separate `brain-ui` repo. So the classic
singleton-SSR hazard (one server process leaking state between requests) is not
a live bug — it is a door this design closes for free rather than a fire it puts
out. Multi-root is likewise not a shipped requirement; the honest argument for
(a) is test isolation and dependency visibility, and multi-root falls out.

Two real multi-root constraints if it is ever used:

1. **`localStorage` keys are root state.** `chat-store.ts` persists
   `brain-sessionId`, `provider-store.ts` persists the selected provider id,
   `file-store.ts` persists the frontmatter-collapsed flag. Two roots must pass
   different `storagePrefix` values or they overwrite each other.
2. **One WebSocket per root.** `useWebSocket` is already per-mount; with the
   root threaded through it becomes per-root, which is the correct shape.

---

## 2. The container / presentational split

### 2.1 The rule

> A component belongs in `ui-kit` **if and only if** everything it renders
> arrives as a prop and everything it causes leaves as a callback prop.
>
> Concretely, no module under `packages/ui-kit/src/` may import `zustand`, call
> `fetch`, import `api` / `apiBase`, read `uiConfig`, or touch
> `window.location` / `localStorage` / `history`. Everything else in the chat
> UI is a `ui-react` container whose job is to read stores, call the API, and
> render exactly one kit component.

This is mechanically checkable, so it gets a gate rather than a convention:
`scripts/check-kit-purity.ts`, added as the sixth entry in `scripts/lint.ts`'s
explicit list (the list is explicit on purpose — a glob was rejected there
before, so add the entry, do not widen a pattern).

A container that grows past ~40 lines is a smell: it means logic that belongs in
a store mutator or a kit component is sitting in the adapter.

### 2.2 The six fetch-on-mount components

They all call the same singleton: `api` from
`packages/ui-react/src/lib/api-client.ts` (~70 methods, each a `fetchJson`
against `apiBase()`).

**What replaces the fetch: injected async callbacks, with data already
resolved.** A kit component never awaits anything it did not receive as a prop.
The container owns the request, the cancellation epoch, and the error string;
the kit component renders `editing | saving | saved | error` from props.

| Today | `ui-kit` (pure view) | `ui-react` (container) |
|---|---|---|
| `components/quick-actions/add-modal.tsx` `AddPanel` | `AddForm` — props `knownTypes: string[]`, `state: "editing"\|"saving"\|"saved"\|"error"`, `error`, `savedPath`, `indexed?`, `indexing`; callbacks `onSubmit(draft: AddDraft)`, `onClose()` | keeps `api.brainStats()` + `api.brainAdd()` and the `operation.epoch` guard |
| `components/settings/skills-tab.tsx` `SkillsTab` | `SkillsList` + `SkillEditor` — props `skills: SkillEntry[]`, `busy: string \| null`, `error`, `warning`, `editing`, `outcomes`; callbacks `onCreate/onSave/onToggle/onRemove/onInstallZip/onInstallGitHub` | the `reload()` loop + `active`-gated refetch |
| `components/settings/passkey-tab.tsx` `PasskeyTab` | `PasskeyList` — props `passkeys`, `status`, `busy`; callbacks `onRegister/onRename/onDelete/onSignOut` | `lib/passkeys` + `api.passkey*` |
| `components/settings/web-search-settings.tsx` `WebSearchSection` | `WebSearchChain` — props `config: WebSearchConfig`, `saving`, `error`; callback `onReorder(order: string[])` | `api.webSearchConfig()` / `api.webSearchUpdate()` |
| `components/connectivity/login-screen.tsx` `LoginScreen` | `LoginForm` — props `appName`, `methods: { password: boolean; passkey: boolean }`, `busy`, `error`; callbacks `onPassword(pw)`, `onPasskey()` | `api.authMethods()` + `lib/passkeys` |
| `components/activity/push-toggle.tsx` `PushToggle` | `PushSwitch` — props `state: "granted"\|"default"\|"blocked"\|"unsupported"`, `busy`, `reason?`; callback `onToggle()` | `lib/push-registration` |

Two streaming panels follow the same rule with a different prop shape:
`StreamingPanel` and `WhatsupPanel` keep the `ReadableStream` reader loop in the
container and hand the kit a `StreamingOutput` with
`{ text: string; running: boolean; error: string | null; onCancel(): void }`.

### 2.3 Why there is no `DataSource` interface (no-new-seams)

ROADMAP bind #2 and `docs/extending/README.md` say a seam exists only where a
second implementation is plausible within a year, and the not-pluggable list
already names "Bun + Hono server, React PWA client — no framework adapters" and
the wire protocol. A `BrainDataSource` interface would be an extension point
with exactly one implementation and no plausible second one. So: **none is
introduced.** Kit components take props and callbacks; that is not an interface,
it is a function signature.

The one type this proposal does add is deliberately *derived*, not authored:

```ts
// packages/ui-react/src/lib/api-client.ts
export type BrainApi = typeof api;
export function createBrainApi(getBase: () => string): BrainApi;
```

`BrainApi` is the type of the existing concrete object. It exists so a root can
hold the client and a test can pass a fake — it is dependency injection of one
implementation, not a pluggability promise. It is not documented in
`docs/extending/`, carries no `@experimental` marker, and nothing resolves it
from config by name. If someone later wants to swap it, *that* is a seam
discussion.

Similarly, `ToolRendererRegistry` (§4) is not a new seam: `ToolRenderer` is
already one of the eight declared seams. Making its registry instantiable
changes the plumbing of an existing seam, not the count of them.

---

## 3. Config and `apiBase()`

`packages/ui-react/src/config.ts` is a module singleton that
`configureBrainUi()` mutates before first render, and
`packages/ui-react/src/lib/backend.ts` derives `apiBase()` / `getWsUrl()` /
`getBackendUrl()` from it. Its header already explains why they are *functions*
and not constants: ES imports are hoisted, so a constant would capture the
default before the shell configured anything. **That late-binding property must
survive the refactor**, because `fetchJson` calls `apiBase()` per request.

Target:

```ts
// packages/ui-react/src/config.ts — after
export interface BrainUiConfig { /* unchanged */ }

export const DEFAULT_CONFIG: BrainUiConfig = { /* today's defaults */ };

/** The default root's config object. Still exported, still mutable, still the
 *  thing `configureBrainUi()` writes to — so an existing shell is unaffected. */
export const uiConfig: BrainUiConfig = defaultRoot.config;

export function configureBrainUi(overrides: Partial<BrainUiConfig>): void {
  applyConfig(defaultRoot, overrides);   // identical semantics to today
}
```

```ts
// packages/ui-react/src/lib/backend.ts — after
export function apiBaseFor(config: BrainUiConfig): string {
  return `${config.backendUrl}/api`;
}
/** Unchanged public signature; reads the default root. */
export function apiBase(): string {
  return apiBaseFor(defaultRoot.config);
}
```

New, for components:

```ts
export function useBrainConfig(): BrainUiConfig { return useBrainUiRoot().config; }
export function useBrainApi(): BrainApi { return useBrainUiRoot().api; }
```

The five components that read `uiConfig` today (`MessageBubble`, `AskUserCard`,
`ShareBlock`, `Composer`, `LoginScreen`) switch to `useBrainConfig()` — except
that under the §2 rule their *presentational* halves take `appName` /
`assistantName` / `shareTitle` / `composerPlaceholder` as plain props, and only
the `ui-react` container calls `useBrainConfig()`. A kit component never knows
the config exists.

`createBrainApi(getBase)` takes a *getter*, not a string, so a root created
before `configureBrainUi()` runs still resolves the right base at request time.
That preserves the hoisting property `config.ts`'s header is about.

`registerDevHandle()` stays, with the same contract (register now, install if
and when `devTools` turns on), but the installers are registered inside store
factories and only the default root installs them.

`scripts/check-env-access.ts` keeps passing: nothing here reads
`import.meta.env` or `process.env`, and the chokepoint is still one file.

---

## 4. The tool-renderer registry

### 4.1 Global or instance-scoped?

**Instance-scoped, with a module default** — same shape as the stores, same
reason plus one that is specific to Storybook.

The specific reason: `registerBuiltinRenderers()` in
`packages/ui-react/src/components/chat/renderers/index.ts` is guarded by a
module-level `let registered = false` and is called **during render** at the top
of `ToolCallTimeline`. `resetToolRenderers()` clears the registry but does not
clear that flag, so a story that resets to exercise a custom pack permanently
un-registers the builtins for every other story in the process. Storybook docs
mode mounts many stories at once; this is not a hypothetical.

```ts
// packages/ui-sdk/src/client/renderers.ts — after (additive)
export interface ToolRendererRegistry {
  register(pack: RendererPack): void;
  resolve(tool: ToolCallView, backendId: string): ToolRenderer | null;
  reset(): void;
}

export function createToolRendererRegistry(): ToolRendererRegistry;

/** The default instance the free functions address. */
export const defaultToolRendererRegistry: ToolRendererRegistry =
  createToolRendererRegistry();

export function registerToolRenderers(pack: RendererPack): void {
  defaultToolRendererRegistry.register(pack);
}
export function resolveToolRenderer(t: ToolCallView, b: string): ToolRenderer | null {
  return defaultToolRendererRegistry.resolve(t, b);
}
export function resetToolRenderers(): void {
  defaultToolRendererRegistry.reset();
}
```

`ToolRenderer`, `RendererPack`, `ToolCallView` and `ToolSemantics` are
unchanged, so `@schlessera/brain-ui-sdk/client` stays backward compatible.
`ToolCallTimeline` switches from the free `resolveToolRenderer` to
`useBrainUiRoot().renderers.resolve(...)`, and `registerBuiltinRenderers(reg)`
takes a registry and tracks "already registered" **on the registry**, not in a
module flag. Build-time-only registration (the policy in the file header) is
unchanged: packs are still imported by one module, there is still no runtime
plugin loading.

### 4.2 The D3 seam

D3: an LLM calls an MCP/bridge tool, and the tool *result* payload renders as a
rich in-chat component. Two findings shape the design:

1. **The wire already carries structured payloads.** `ServerToolResult.output`
   is a `string` (`packages/ui-sdk/src/protocol.ts:352`), and every existing
   bridge tool already returns `textResult(JSON.stringify(payload), details)`
   (`packages/ui-backend-pi/src/bridge-tools.ts`). The client parses
   `tool.output`. **No `PROTOCOL_REV` bump is needed for D3.**
2. **zod → JSON Schema is already the house idiom.**
   `packages/ui-backend-pi/src/bridge-tools.ts:35` does
   `z.toJSONSchema(schema, { io: "input" })`; the Claude adapter passes
   `ASK_USER_INPUT_SCHEMA.shape` to the SDK's `tool()` helper. zod v4 is already
   a dependency of `ui-sdk`.

**The contract object.** React-free, so the server can import it without
pulling React or a component into the backend bundle:

```ts
// packages/ui-sdk/src/tool-components/contract.ts
import { z } from "zod";

export interface ToolComponentContract<
  I extends z.ZodObject = z.ZodObject,
  P extends z.ZodObject = z.ZodObject,
> {
  /** Bare tool name. The per-adapter prefix is applied by BRIDGE_TOOL_POSTURE. */
  name: string;
  /** LLM-facing prose. Also the source for the system-prompt append (below). */
  description: string;
  /** THE tool schema. Validated server-side, published to the LLM. */
  input: I;
  /** THE result payload. Serialised server-side, and the component's props. */
  payload: P;
}

/** Identity function, for inference and excess-property checking. */
export function defineToolComponent<I extends z.ZodObject, P extends z.ZodObject>(
  contract: ToolComponentContract<I, P>
): ToolComponentContract<I, P> {
  return contract;
}

/** The LLM-facing tool definition. Same shape `toPiParameters` already produces. */
export function toToolParameters(contract: ToolComponentContract) {
  const { $schema: _s, ...parameters } = z.toJSONSchema(contract.input, {
    io: "input",
  });
  return parameters;
}
```

**The component** lives in `ui-kit` and is pure, because its props *are* the
payload:

```tsx
// packages/ui-sdk/src/tool-components/timeline.ts   (React-free)
export const BRAIN_TIMELINE = defineToolComponent({
  name: "brain_timeline",
  description: "Render a dated timeline of brain documents in the chat. …",
  input: z.object({
    query: z.string().describe("What to build the timeline from."),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  payload: z.object({
    title: z.string(),
    events: z.array(z.object({
      date: z.string(),
      label: z.string(),
      path: z.string().optional(),
    })),
  }),
});
export type BrainTimelineProps = z.infer<typeof BRAIN_TIMELINE.payload>;

// packages/ui-kit/src/tool-components/brain-timeline.tsx  (pure, storyable)
export function BrainTimeline({ title, events }: BrainTimelineProps) { … }
```

**The binding** is where drift becomes a compile error:

```tsx
// packages/ui-react/src/components/chat/renderers/tool-components.tsx
import type { ComponentType } from "react";
import { z } from "zod";
import type {
  RendererPack, ToolRenderer, ToolCallView,
} from "@schlessera/brain-ui-sdk/client";
import type { ToolComponentContract } from "@schlessera/brain-ui-sdk";

/**
 * The Component's props must be exactly `z.infer<contract["payload"]>`.
 * A field added to the schema and not to the component — or the reverse —
 * fails `tsc --noEmit`.
 */
export function bind<C extends ToolComponentContract>(
  contract: C,
  Component: ComponentType<z.infer<C["payload"]>>
): ToolRenderer {
  return {
    match: contract.name,
    label: contract.name,
    Output({ tool }: { tool: ToolCallView }) {
      if (tool.isError || tool.output === undefined) return null;
      let raw: unknown;
      try { raw = JSON.parse(tool.output); } catch { return null; }
      const parsed = contract.payload.safeParse(raw);
      // A payload from before the schema changed falls through to the caller's
      // GENERIC_RENDERER rather than throwing inside an old transcript.
      if (!parsed.success) return null;
      return <Component {...(parsed.data as z.infer<C["payload"]>)} />;
    },
  };
}

export const toolComponentPack: RendererPack = {
  renderers: [bind(BRAIN_TIMELINE, BrainTimeline)],
};
```

**Why they cannot drift**, stated plainly:

- The LLM's parameters are `z.toJSONSchema(contract.input)`; the server handler
  validates with `contract.input.parse`. Same object, no second declaration.
- The component's props type is `z.infer<typeof contract.payload>`; the values
  come from `contract.payload.safeParse`. Same object.
- `bind()` refuses to compile if the component's props and the payload type
  differ.
- Add a `.test-d.ts` asserting
  `Expect<Equal<ComponentProps<typeof BrainTimeline>, z.infer<typeof BRAIN_TIMELINE.payload>>>`,
  mirroring the existing `protocol.ts` / `schemas.ts` `.test-d.ts` precedent.

**The system prompt is generated, not hand-written.**
`BRAIN_UI_SYSTEM_PROMPT_APPEND` in
`packages/ui-sdk/src/server/system-prompt.ts` is today the only thing telling a
model what the UI can render, and `.plan/DECISIONS.md` flags that a new in-chat
component must be described there as well as schema'd. Derive that paragraph
from the contract list (`name` + `description`) so "schema'd but undescribed" is
not reachable.

**Contract obligations.** The infrastructure above (`defineToolComponent`,
`bind`, registry instancing) is additive and needs no `CONTRACT:` commit.
*Shipping an actual tool* does: an LLM-callable tool name and schema is the
compatibility contract per AGENTS.md and ROADMAP bind #4, so the first real in-
chat component lands as a `CONTRACT:` commit that updates
`docs/integration-contract.md` in the same commit. `docs/extending/README.md`
gets an update too, since `ToolRenderer` is a listed seam and this changes how
one is authored.

---

## 5. Migration sequencing

Every step leaves `bun run test`, `bunx tsc --noEmit` and `bun run lint` green.
"Bulk" = safe to hand to a cheap model with the pattern already established;
"judgement" = design decisions inside the step.

| # | Step | Kind | Notes |
|---|---|---|---|
| **S1** | `ui-sdk`: `createToolRendererRegistry()` + `defaultToolRendererRegistry`; free functions delegate. `registerBuiltinRenderers(registry)` tracks registration on the registry. | judgement (small) | Additive to `@schlessera/brain-ui-sdk/client`. New test: two registries do not see each other's packs. |
| **S2** | `ui-react`: `createBrainUiRoot()`, `BrainUiProvider`, `defaultRoot`; all 11 stores → `createXStore()` factories; hooks re-expressed as `Object.assign(hook, defaultRoot.stores.x)`. Move the three `registerDevHandle` calls into the factories. | **judgement — the load-bearing step** | Component call sites unchanged. `render-smoke.test.tsx` keeps compiling unchanged. Verify `useStore(store, useShallow(sel))` with a test. |
| **S3** | Thread the root through non-React code: `hooks/use-websocket.ts`, `hooks/websocket-handlers/*` (5 files), `components/chat/use-chat-commands.ts`, `hooks/use-vpn-status.ts`, `hooks/use-share-intake.ts`, `hooks/use-hash-routes.ts`, `voice/asr-clients.ts`, `voice/use-dictation.ts`, and the cross-store reads in `stores/chat-store.ts` / `stores/activity-store.ts`. | bulk, one reviewed signature change | `handleServerMessage(msg, stores)` is a public export — keep an overload where `stores` defaults to `defaultRoot.stores` so the shell is unaffected. |
| **S4** | `createBrainApi(getBase)`, `useBrainApi()`, `useBrainConfig()`; `api`/`apiBase`/`uiConfig`/`configureBrainUi` stay exported bound to the default root. Replace the five `import { uiConfig }` sites. | bulk | Keep `apiBase()` late-binding (getter, not string). |
| **S5** | Create `packages/ui-kit` (D1). **Add it to `scripts/build.ts` and `scripts/publish.ts` in the same commit**, plus a changeset; version in lockstep. Move the ~35 already-pure components; `ui-react` re-exports them from their current paths. Add `scripts/check-kit-purity.ts` as lint gate 6. | bulk move + judgement on the gate | AGENTS.md hard rule, asserted by `tests/release-manifest.test.ts`. A package missing from those lists ships dependents pinned to a version nobody published. `ui-kit` needs its own Tailwind v4 entry mirroring `src/styles.css` (`@import "tailwindcss" source(none)` + `@source` + `@import "./theme.css"`). |
| **S6** | Split the six fetch-on-mount components per §2.2 (plus the two streaming panels). | judgement per component | The epoch/cancellation guards stay in the container; do not let a bulk pass flatten them. |
| **S7** | Split the store-coupled components the design (D4) actually shows, one directory at a time: `XView` in `ui-kit`, `X` in `ui-react`. | bulk once the first directory sets the pattern; selector boundaries are judgement | D4 still bounds *which* components exist; this step only re-homes them. |
| **S8** | `packages/ui-kit/.storybook/` + stories + play functions + `addon-a11y` + Playwright visual baselines (D2). `preview-head.html` loads DM Serif Text / Plus Jakarta Sans / JetBrains Mono, since no fonts are bundled. | judgement | First bundler (Vite) in the tree — dev-only; `ui-kit` still *builds* with `tsc` like every other package. Storybook devDeps excluded from `files[]` per D1. |
| **S9** | D3: `defineToolComponent` + `bind` + the first real in-chat component + generated system-prompt paragraph. | judgement | **`CONTRACT:` commit**, `docs/integration-contract.md` updated in the same commit, `docs/extending/README.md` updated. No `PROTOCOL_REV` bump. |
| **S10** | At 1.0: delete `defaultRoot`; hooks throw without a provider; `uiConfig`/`configureBrainUi`/`apiBase` removed in favour of the root. | judgement | **Major bump — drags all thirteen packages.** Announce in CHANGELOG. Do not do this before 1.0. |

S1–S4 are internal plumbing and can land in one release. S5 is the first release
that publishes a new package — treat it with the `release` skill's checklist,
including `rm bun.lock && bun install` after `bun run version`.

**Flagged commits:** only S9 is a `CONTRACT:` commit. Nothing in S1–S8 touches
CLI `--json` shapes, MCP tool names or schemas, `schema_version`, frontmatter,
or `PROTOCOL_REV`.

---

## 6. Testability payoff

### Today

From `packages/ui-react/tests/render/render-smoke.test.tsx` — the shape every
new test has to copy:

```tsx
import { unregisterDom } from "./dom.js";   // MUST be the first import
import { useUIStore } from "../../src/stores/ui-store.js";
import { clearGraphSceneCache, useGraphStore } from "../../src/stores/graph-store.js";

test("graph page renders clusters", async () => {
  clearGraphSceneCache();                            // module-level LRU, shared
  useUIStore.setState({ activeView: "graph" });      // global
  useGraphStore.setState({                            // global
    mode: "clusters", subgraph: FIXTURE, dataState: "ready",
  });
  const { getByText } = render(<GraphPage />);        // never `screen`
  await waitFor(() => expect(getByText("…")).toBeTruthy());
});
// Whatever this test left in either store is the next test's starting state.
afterAll(unregisterDom);
```

Three global mutations, one cache reset, an ordering constraint on the import
list, and state that outlives the test. A story of the same component needs a
decorator that does all of the above and then races every other story mounted in
docs mode.

### After — a `ui-kit` component test

```tsx
// packages/ui-kit/tests/render/graph-scene.test.tsx
const { getByRole } = render(
  <GraphSceneView
    subgraph={FIXTURE}
    mode="clusters"
    selectedId={null}
    hoveredId={null}
    onSelect={() => {}}
    onHover={() => {}}
  />
);
expect(getByRole("figure")).toBeTruthy();
```

No globals, no reset, no ordering. The props *are* the spec, and the "loading /
empty / error / mobile" variations D4 asks for are four more `render()` calls
with different props.

### After — a `ui-react` container test

```tsx
const root = createBrainUiRoot({ api: fakeApi });
root.stores.graph.setState({ mode: "clusters", subgraph: FIXTURE, dataState: "ready" });

render(
  <BrainUiProvider root={root}>
    <GraphPage />
  </BrainUiProvider>
);
// The next test builds its own root. Nothing leaks, and `clearGraphSceneCache()`
// disappears because the cache moves inside the store factory.
```

### After — a story

```tsx
// packages/ui-kit/src/components/graph/graph-scene.stories.tsx
const meta = { component: GraphSceneView } satisfies Meta<typeof GraphSceneView>;
export default meta;

export const Clusters: Story = { args: { subgraph: FIXTURE, mode: "clusters" } };
export const Empty:    Story = { args: { subgraph: EMPTY,   mode: "clusters" } };
export const Failed:   Story = { args: { subgraph: null, error: "Graph not computed" } };
```

Args only. No decorator, no `setState`, no cross-story interference — which is
what makes the D2 play functions and visual baselines trustworthy rather than
order-dependent.

One constraint that does **not** go away: the `bun test` DOM contract in
`packages/ui-react/tests/render/dom.ts` (all render tests in one file per
process, never `screen`). `ui-kit` is a separate package with its own
`bun test tests` invocation, so it gets its own process and its own single
render file. Storybook runs in a real browser and is unaffected. Do not try to
run stories as `bun test` cases in the same process as the render file.

---

## 7. Risks and blast radius

| Risk | Severity | Mitigation |
|---|---|---|
| An existing embedder of `@schlessera/brain-ui-react` breaks | **low, by construction** | The default root keeps every current export working identically. The single documented behaviour change: module-scope `useXStore.getState()` addresses the default root, not a provider's root. |
| Accidental major bump | high if it happens | All thirteen packages version in lockstep and an unintended major has shipped twice (AGENTS.md). Keep S1–S9 additive; the only major is S10, at 1.0. |
| `ui-kit` missing from `scripts/build.ts` / `scripts/publish.ts` | **high** | Both drive hardcoded lists; a missing package is silently skipped and its dependents ship pinned to an unpublished version. Add it in the same commit as the package; `tests/release-manifest.test.ts` asserts it. |
| Two roots fighting over `localStorage` | medium, only under multi-root | `storagePrefix` on `createBrainUiRoot()`; the three keys are `brain-sessionId` (`stores/chat-store.ts`), the provider id (`stores/provider-store.ts`) and the frontmatter-collapsed flag (`stores/file-store.ts`). |
| `useStore(store, useShallow(sel))` behaves differently from `useXStore(useShallow(sel))` | low | Documented zustand pattern, but `tool-call-timeline.tsx` depends on it — cover it with a test in S2 before touching call sites. |
| React 18 peer floor | medium | CI's pack job typechecks a React-18 consumer against the emitted `.d.ts`. `createContext` as a JSX provider (`<RootContext value={…}>`) is React 19 syntax — write `<RootContext.Provider value={…}>` for the 18 floor. |
| Storybook/Vite is the first bundler in the tree | medium | Dev-only. `ui-kit` publishes through the same `tsc` + `@tailwindcss/cli` path as `ui-react`; Storybook devDeps stay out of `files[]` (D1). |
| A bulk pass flattens the cancellation epochs in S6 | medium | `AddPanel`'s `operation.epoch` and `SkillsTab`'s `active`-gated reload are correctness, not style. Review those diffs by hand. |
| `.plan/` leakage gate | low but absolute | Repo-relative paths only; any example persona is "Alex Example". |

**Is a deprecation shim warranted? Yes — and the default root *is* the shim.**
It costs one eager module-level object and a documented caveat, and it converts
what would otherwise be a thirteen-package major into a minor. Its removal is
S10, at 1.0, announced in the CHANGELOG, alongside the rest of the
`@experimental`-until-1.0 seam cleanup.

---

## 8. Open questions

- **Does the new design introduce a light mode?** The app is dark-only by
  construction today (`use-graph-theme.ts` says so outright). If the design file
  adds one, that is a token-architecture change in `ui-kit`'s theme, not a
  Storybook toggle, and it should be settled before S5 so tokens are authored
  once.
- **Does `ui-kit` re-export the theme, or does `ui-react` keep owning it?**
  Recommendation: `ui-kit` owns `theme.css` and `styles.css`; `ui-react`
  re-exports both from its existing `./styles.css` / `./theme.css` export paths
  so consumers do not change an import. Needs confirming against the
  `check-dist.ts` / packaging smoke test before S5.
- **Which D4 components are store-coupled in the new design?** Pending the
  `kit/Brain Kit.dc.html` inventory; S7's scope is bounded by it.
