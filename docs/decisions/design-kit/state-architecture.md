# Design kit — State architecture

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-15--state-architecture-proposal-pending-independent-review"></a>

## 2026-09-15 — state architecture (proposal, pending independent review)

The full proposal is not kept — the shipped stores are the answer. Summarised here; **not yet ratified**
— it goes to an independent gpt-6-astra review before any code moves.

**D13 (proposed) — layered answer, not a single pattern.** The four pains do not
share one cause: instancing fixes test leakage and multi-root, while
*not importing stores into presentational components* fixes invisible
dependencies. Doing only one leaves half the pain. So:

- **`ui-kit` is 100% prop-driven** — no zustand, no `fetch`, no `uiConfig`, no
  `localStorage`, no `window.location`. Enforced mechanically by a sixth lint
  gate, `scripts/check-kit-purity.ts`, not by discipline.
- **`ui-react` keeps the stores**, but as `createXStore()` factories held in one
  `BrainUiRoot` behind a `BrainUiProvider`.

**Why this is affordable:** hook names and call signatures are preserved.
`useUIStore((s) => s.activeView)` is character-identical before and after,
because the hook becomes `useStore(useBrainUiRoot().stores.ui, selector)`.
Churn across the ~250 component call sites in ~60 files is **zero**. What moves
is ~55 `getState()` calls in 17 non-component files (websocket handlers, voice,
command dispatch), and those keep compiling from day one via `.getState()` /
`.setState()` statics attached to a default root.

**The default root is the deprecation shim** — an eager module-level instance
used when no provider is mounted. Every current export of
`@schlessera/brain-ui-react` (nine store hooks, `uiConfig`, `configureBrainUi`,
`api`, `apiBase`) keeps working identically. That turns what would otherwise be
a thirteen-package lockstep **major** into a **minor**. The shim is removed at 1.0.

Rejected: (b) alone — leaves 40 store-coupled components untestable and does the
store work twice; (c) a single sliced store — ~2,000 lines of merged state, and
`graph-store`'s module LRU plus request tokens, `activity`'s run-keyed spans and
`chat`'s ~30 `ChatKey`-keyed mutators do not merge; a `DataSource` interface —
refused under the no-new-seams rule. The one type introduced, `BrainApi = typeof
api`, is *derived from* the existing concrete object. That is injection, not
pluggability, so it does not go in `docs/extending/`.

<a id="two-findings-that-change-the-d3-design"></a>

### Two findings that change the D3 design

1. **No `PROTOCOL_REV` bump is needed.** `ServerToolResult.output` is already a
   string, and bridge tools already do `textResult(JSON.stringify(payload),
   details)`. The client just parses it. D3 is cheaper than assumed.
2. **zod → JSON Schema is already the house idiom** —
   `z.toJSONSchema(schema, { io: "input" })` in `ui-backend-pi/src/bridge-tools.ts`.

So the D3 seam is: one React-free `ToolComponentContract { name, description,
input, payload }` living in `ui-sdk` (server-importable), the component in
`ui-kit` typed as `z.infer<contract["payload"]>`, and a `bind(contract,
Component)` in `ui-react` that makes drift a `tsc` error rather than a runtime
surprise. The `BRAIN_UI_SYSTEM_PROMPT_APPEND` paragraph is *generated* from the
contract list, so "schema'd but never described to the model" is unreachable.

<a id="a-real-bug-found-on-the-way"></a>

### A real bug found on the way

`registerBuiltinRenderers()` guards itself with a module-level
`let registered = false` that `resetToolRenderers()` does **not** clear. One
story calling reset therefore permanently un-registers the builtins for every
other story in the same docs-mode page. This alone justifies making the renderer
registry instance-scoped with a module default.

<a id="sequencing--10-steps-each-leaving-the-tree-green"></a>

### Sequencing — 10 steps, each leaving the tree green

S1 registry instancing → **S2 root + store factories (load-bearing, judgement)**
→ S3 thread the root through non-React code (bulk) → S4 api/config injection
(bulk) → S5 create `ui-kit` **and add it to `scripts/build.ts` and
`scripts/publish.ts` in the same commit** → S6 the six fetch-on-mount splits
(judgement — a bulk pass would flatten `AddPanel`'s epoch guard) → S7
store-coupled splits (bulk) → S8 Storybook → **S9 first real in-chat component,
a `CONTRACT:` commit** → S10 remove the shim at 1.0 (major).

Only S9 touches the compatibility contract.

<a id="2026-09-15--independent-verification-of-d13-gpt-6-astra-read-only"></a>

## 2026-09-15 — independent verification of D13 (gpt-6-astra, read-only)

Full report kept out of tree. Method was AST-based, not grep: a Bun script
walking every `.ts`/`.tsx` under `packages/ui-react/src` with the TypeScript
compiler API, counting `CallExpression` nodes. Two claims were checked by
*executing* code in a fresh Bun process. Verdicts:

| Claim | Verdict |
|---|---|
| 1. Zero component call-site churn | PARTIALLY TRUE |
| 2. 55 `getState()` in 17 non-component files | PARTIALLY TRUE |
| 3. No `PROTOCOL_REV` bump needed for D3 | PARTIALLY TRUE |
| 4. `registerBuiltinRenderers` flag survives reset | **CONFIRMED** |
| 5. Shim keeps every export identical → minor | **REFUTED** |

<a id="corrections-that-change-the-plan"></a>

### Corrections that change the plan

**Counts.** 247 hook invocations in **36** files, not ~250 in ~60. Of those, 239
pass an arrow selector, 8 pass `useShallow`, and **0** omit the selector or
destructure the whole store. No zustand middleware anywhere, no `.subscribe`,
`.destroy` or `.persist` in source. So the selector-rewrite really is zero-churn.

> **2026-09-30 — Implementation context (the static-store audit below).** These
> sites describe the pre-isolation implementation: the
> [chat handlers](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/chat/chat-page.tsx#L142-L168),
> [composer](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/chat/composer.tsx#L205),
> [provider refresh](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/settings/pi-accounts.tsx#L71)
> and [span loader](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/activity/span-bits.tsx#L88)
> reached static stores, including the
> [default activity store](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/activity-store.ts#L261-L270).
> [Root isolation](https://github.com/schlessera/brain-kit/commit/6b57843a471fc48ca3aa446f168aaf624b50b221)
> replaced those paths with root-owned stores. The
> [D15 isolation decision](#2026-09-15--d15-the-default-root-shim-is-a-type-design-bug-not-a-migration-aid)
> still binds; the following present tense is the audit's historical finding.

**But "zero component edits" is false.** Five component call sites reach the
store through a static and would silently bind to the *default* root while
rendering under a provider — `chat-page.tsx:142,158,168` (tool approval,
ask-user submit, ask-user cancel), `composer.tsx:205` (message submit + draft
correlation), `pi-accounts.tsx:71` (provider refresh). Plus one indirect:
`span-bits.tsx:88` calls `loadSpanPayloads`, which reads and writes the default
activity store inside `activity-store.ts:261,270`. These six are real work, not
shim-covered. **This is the failure mode to watch: it compiles, and it is wrong.**

**`getState()` inventory is exactly 55 in 17 files** — but 5 of those sit in
component `.tsx` files, so "17 non-component files" is wrong. Outside
`src/components/` it is 43 calls in 13 files. Heaviest: `use-websocket.ts` (12),
`use-chat-commands.ts` (7), `activity-store.ts` (5).

**Attach the whole store API, not just getState/setState.** Tests already call
`.getInitialState()` in three places (`getInitialState()`,
`render-smoke.test.tsx:143,144`, `getInitialState()`,
`graph-store.test.ts:105`). `Object.assign(hook, store)` covers it; a
hand-picked two-method shim would not.

**D3's premise was overstated.** Only **two of four** Pi bridge tools return
`textResult(JSON.stringify(payload), …)` — `ask_user` and
`get_current_location`. `query_activity` returns prose with nonce-delimited JSON
inside, and `request_image_mask` returns a human-readable sentence with the
structure in `details`. Worse: **the Pi adapter sends text content only and drops
`details`** (`type: "tool_result"`, `event-adapter.ts:34`; `toolResultText`,
`:46`), and Claude uses MCP `content` arrays via a different path
(`const output =`, `stream-adapter.ts:167`). So "JSON payload in the output
string" is a *convention we would be establishing*, not one we are following.
The no-bump conclusion still holds — `Additions never bump it`,
`packages/ui-sdk/src/protocol.ts:45` states additions do not bump the rev, only semantics changes
do — and `ToolCallView.output?: string` already lets a renderer parse
locally. Turning `output` itself into an object would be a different, breaking
change.

**Claim 5 is genuinely broken as written.** Zustand's `UseBoundStore` carries two
overloads, `(): State` and `<U>(selector) => U`. The proposal's wrapper declares
only the selector form, which the TypeScript compiler rejects against the real
`UIState`: `TS2554 Expected 1 arguments, but got 0` and `TS2322 not assignable to
UseBoundStore<StoreApi<UIState>>`. That hits **all nine exported store hooks**.
No current source component calls the zero-arg form, so runtime is fine — this is
a pure *type* break, and a type break is a breaking change for TS consumers. Fix
is cheap (declare both overloads), but the "therefore it is a minor" reasoning
does not stand on its own and must be re-argued after the wrapper is written.

> **2026-09-30 — Implementation context (the SSR evidence below).** The import
> experiment used the old guarded storage reads in
> [chat-store](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/chat-store.ts#L228-L364),
> [provider-store](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/provider-store.ts#L8-L44)
> and [file-store](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/stores/file-store.ts#L26-L135).
> [Root isolation](https://github.com/schlessera/brain-kit/commit/6b57843a471fc48ca3aa446f168aaf624b50b221)
> moved storage behind the injected store environment. These original file and
> line citations preserve the experiment, not the current construction sites;
> the SSR reasoning and D15's separate type-design ruling are unchanged.

**SSR concern dismissed, with evidence.** All three construction-time
`localStorage` reads are guarded (`chat-store.ts:364`/`228`,
`provider-store.ts:44`/`8`, `file-store.ts:135`/`26`); no initialiser touches
`matchMedia` or `window` unguarded, and fetches happen inside actions. A
fresh-process import of `src/index.ts` with `window`/`localStorage` absent and
`fetch` replaced by a throwing sentinel succeeded. An eager default root is safe.

> **2026-09-30 — Implementation context (the renderer finding below).** The
> [historical registration latch](https://github.com/schlessera/brain-kit/blob/5835058d4eeee18aae483b180234e9c861ba9c7b/packages/ui-react/src/components/chat/renderers/index.ts#L10-L18)
> caused this reproduced failure. The
> [renderer fix](https://github.com/schlessera/brain-kit/commit/039f2c6a0d0baa1c8a4b260ccede6eecaff82836)
> removed the latch and preserved built-ins through reset. The
> [current registration](../../../packages/ui-react/src/components/chat/renderers/index.ts)
> relies on registry deduplication. The audit is evidence for the fix, not an
> outstanding failure in current registration.

**The renderer bug is real and was reproduced**: register → resolve (non-null) →
reset → register → resolve (**null**). `registered` in
`components/chat/renderers/index.ts:10` is never cleared by
`resetToolRenderers()` (`resetToolRenderers`,
`ui-sdk/src/client/renderers.ts:184`). The existing
`registration-on-mount.test.tsx` sidesteps it by running in separate Bun child
processes — an isolation workaround, not a test of recovery. Fix this in S1.

<a id="status"></a>

### Status

D13 is **ratified with the six corrections above folded in**. The architecture
stands; three of its supporting numbers did not survive contact, and one of its
code sketches is type-incorrect.

<a id="2026-09-15--d15-the-default-root-shim-is-a-type-design-bug-not-a-migration-aid"></a>

## 2026-09-15 — D15: the default-root shim is a type-design bug, not a migration aid

On the six sites that "compile and are wrong": *that sounds like a bad type
design.* Correct, and it invalidates the shape of D13's shim rather than just
its details.

A default root that any `useXStore.getState()` silently resolves against is a
design in which **the wrong thing typechecks**. Marking those six call sites as
"real work, watch out for them" is a code-review promise, and code-review
promises do not survive a refactor of this size. If provider-scoped code can
reach the default root without saying so, someone will, and nothing will fail.

<a id="the-reframe"></a>

### The reframe

The 55 static call sites are not components grabbing globals. Almost all of them
are the **connection layer** — `use-websocket.ts` (12), `use-chat-commands.ts`
(7), the six `websocket-handlers/*`, `voice/*`. That layer legitimately has
exactly one root per connection. So the root should be **bound at construction
and closed over**, not looked up ambiently:

- `createWebSocketClient({ root })`, handlers close over `root`, and
  `handleServerMessage(msg, root)` takes it explicitly.
- Ambient access then does not exist on the internal path at all. Passing the
  wrong root stops being a thing you can do quietly; it becomes a thing you
  cannot express.

That is not a shim. It is the correct decomposition, and it is what makes the
six known-bad sites *unrepresentable* rather than merely documented.

<a id="what-the-statics-become"></a>

### What the statics become

They stay, because they are the public-compat story for existing consumers of
`@schlessera/brain-ui-react`, and dropping them is the difference between a
minor and a major. But they are fenced:

1. Marked `@deprecated` with the replacement named in the tag.
2. **Banned inside this repo by a lint rule** (`scripts/lint.ts` already hosts
   the project's own gates, so this is a sixth one, next to
   `check-kit-purity.ts`). Internal code physically cannot use them.
3. Where a compat static must return a store API, it is branded so it cannot be
   passed to anything expecting a provider-scoped store.

External compatibility preserved; internal silent wrongness impossible. The
deprecation window then has a real end: the statics go at 1.0 with the shim.

<a id="consequence-for-sequencing"></a>

### Consequence for sequencing

D13's S2/S3 split changes. "Thread the root through non-React code" stops being
a mechanical bulk step that can lag behind — it is the step that *earns* the
type safety, and it lands with or immediately after the store factories. The
lint ban is what holds the line afterwards, and it is cheap to write.

<a id="the-general-rule-this-sets"></a>

### The general rule this sets

Prefer making the wrong state unrepresentable over documenting it. Any place
this refactor is tempted to say "these N call sites need care", stop and ask
whether the type can refuse them instead. A migration that relies on vigilance
at 55 call sites is not a migration, it is a bet.

