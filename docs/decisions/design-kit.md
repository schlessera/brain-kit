# Decisions — the design kit and the chat surface

Why `packages/ui-kit`, `packages/ui-react` and the chat surface are shaped the
way they are. D1 through D50, dated, with the alternatives that were rejected
and the measurements that decided them.

**Append-only. Supersede an entry; do not rewrite one.** An entry that turned
out to be wrong is more useful with its correction underneath it than deleted —
several below were superseded exactly that way, and the pair is the record.

This is a decision log, not a status file. What is *open* lives in the issue
tracker; see [`docs/process/github.md`](../process/github.md). The hard rules
every change must respect are in [`AGENTS.md`](../../AGENTS.md), and the
decisions that bind the project as a whole are in
[`ROADMAP.md`](../../ROADMAP.md) under "What binds future work" — this file does
not restate either, because a second copy of a rule is a copy that drifts.

One trap worth knowing before you edit this file: **it is inside the leakage
gate.** `scripts/check-leakage.ts` scans the whole tree, untracked files
included, and there are no exempt directories. Absolute home-directory paths and
decisions attributed to a person by name both trip it. Use repo-relative paths,
and attribute to "the maintainer".

## Constraints discovered during research

- **These documents are inside the leakage gate, and this bit us.**
  `scripts/check-leakage.ts` scans the whole tree *including untracked files*,
  and there are no exempt directories. Two ways to trip it, both observed:
  1. An absolute home-directory path — the home path contains a banned personal
     string. Use repo-relative paths everywhere.
  2. **Attributing a decision to a person by name.** Six lines in these very
     files named the maintainer directly and failed the gate on a tree that was
     otherwise clean. Fixed by attributing to the role instead. (Writing the
     note about this mistake, with the name quoted as the example, failed the
     gate a second time — the gate does not care about context.)
  **Standing rule: in any document in this repository, refer to people by role, never by
  name.** Run `bun scripts/check-leakage.ts` before committing plan docs — it is
  the same gate CI runs, and it has no exempt directories.
- **There is no bundler in this repo today.** `ui-react` builds with plain `tsc`
  plus one `@tailwindcss/cli` pass; `ui-server` serves a pre-built SPA it does
  not build. The client shell (index.html, mount point, Vite/PWA build, service
  worker) lives in the deployment, not in this repo. Storybook/Vite would be the
  first bundler in this tree — nothing to reuse, but also nothing to fight.
- **The tool-renderer seam already exists** in `ui-sdk/src/client/renderers.ts`
  (`ToolRenderer`, `RendererPack`, `registerToolRenderers`, `resolveToolRenderer`,
  `resetToolRenderers`). `resetToolRenderers()` is exactly the hook a Storybook
  decorator needs. Per the no-new-seams rule, build on it rather than inventing
  a parallel registry.
- **`ui-sdk/src/protocol.ts` (`PROTOCOL_REV = 3`) is the fixture contract**, with
  `schemas.ts` as its zod mirror and a `.test-d.ts` pinning type-schema equality.
  Storybook fixtures must be typed against these, not hand-rolled shapes. Note
  ui-react's `ToolCall` is a superset of the SDK's `ToolCallView` — author
  fixtures as the richer `ToolCall`.
- **`BRAIN_UI_SYSTEM_PROMPT_APPEND`** in `ui-sdk/src/server/system-prompt.ts` is
  today the only thing describing UI capabilities to a model. Any new in-chat
  component (D3) has to be described there as well as schema'd.
- **Tailwind v4, CSS-only config — no `tailwind.config.js` exists.**
  `ui-react/src/styles.css` is four lines: `@import "tailwindcss" source(none);`
  `@source "./";` `@import "./theme.css";`. `ui-kit` must follow the same idiom.
- **The app is dark-only today.** No `.dark` class, no `prefers-color-scheme`,
  no `[data-theme]`; `use-graph-theme.ts` says so outright. Tokens are amber
  primary `#e09f3e`, teal accent `#5bb5a2`, near-black surfaces. Whether the new
  design introduces a light mode is an open question for the design file — if it
  does, that is a token-architecture change, not a Storybook toggle.
- **No fonts are bundled** — no `@font-face`, no Google import. The deployment
  shell loads DM Serif Text / Plus Jakarta Sans / JetBrains Mono. Storybook has
  no shell, so it must load them itself in `preview-head.html`.
- **`--radius` is defined but never used**, and there is no spacing scale. The
  house idiom is Tailwind defaults plus arbitrary values (`text-[11px]`,
  `font-[family-name:var(--font-mono)]`). A real token set is something `ui-kit`
  gets to introduce.
- **All 11 zustand stores are plain module singletons — there is no context
  provider anywhere.** A Storybook decorator cannot inject a mock store; it has
  to `setState()` on the real one, which `render-smoke.test.tsx` already does.
  Two further module singletons stories must set: `uiConfig` (via
  `configureBrainUi()`) and `apiBase()`. This is the strongest argument for
  `ui-kit` components being prop-driven and store-free.
- **Several store-free components still `fetch` on mount** (`AddPanel`,
  `SkillsTab`, `PasskeyTab`, `WebSearchSection`, `LoginScreen`, `PushToggle`),
  so their stories need request mocking (MSW) rather than just props.
- **There is no router dependency.** Navigation is `useUIStore.activeView` (the
  shell switches; the package only exports pages), a `useHashRoutes()` hook
  two-way syncing `#/files/<path>` / `#/graph` / `#/activity/<runId>`, and
  `subagentStack` for a `fixed inset-0` drill-in overlay.

## 2026-09-15 — mandate widened (maintainer)

**D5 — Cross-package refactors are in scope when they buy architecture.**

Changing `ui-react`, `ui-sdk`, `ui-server` and friends is allowed, not merely
tolerated, where there is a real reason — reshaping the state stores is named
explicitly. The goal is a better end state: easier to maintain, easier to
extend, more testable, more consistent. This is not licence for drive-by
rewrites; every cross-package change needs a stated reason and lands with its
own tests.

Interaction with D4: D4 still bounds which *components and screens* get built —
only what the design shows. D5 bounds the *plumbing underneath* them, which may
now be reshaped as far as the architecture goals justify.

Consequences this unlocks:

- The 11 module-singleton zustand stores can be reshaped into an injectable
  form (explicit store instances behind a provider, or a store-free `ui-kit`
  with `ui-react` holding the singleton adapters). Either way stories,
  tests, and a second embedder stop fighting global mutable state.
- `uiConfig` and `apiBase()` singletons are in scope for the same treatment.
- The `ToolRenderer` registry can gain the shape it needs for D3 in-chat
  components rather than a bolt-on beside it.
- Components that `fetch` on mount can have the I/O lifted out, which removes
  the MSW requirement from most stories.

Unchanged and still binding: the `docs/integration-contract.md` contract
(CLI `--json`, MCP tool names/schemas, `schema_version`, frontmatter) — touching
it means a `CONTRACT:` commit and a major-version discussion. The
`ui-sdk` wire protocol (`PROTOCOL_REV`) is a compatibility surface too: bumping
it is allowed under D5 but must be deliberate and versioned, never incidental.

## 2026-09-15 — Storybook stack decisions

Grounded in a Storybook-stack research pass whose findings were *executed*,
not read: a throwaway two-package Bun workspace was built and `storybook build`,
`storybook dev` and browser-mode Vitest were all run green under Bun 1.3.14.

**D6 — Storybook 10.6.0 on the Vite builder, run under Bun.** Verified working:
`bun install` → `bunx storybook build` (3.2s) → `bunx storybook dev` → `bunx
vitest run --project=storybook` against real Chromium. A sibling `workspace:*`
package resolved with no aliasing and no `optimizeDeps` workarounds. Requires
Node 22.12+ (Storybook 10 is ESM-only).

Exact packages — **all Storybook packages pinned to 10.6.0**:
`storybook`, `@storybook/react-vite`, `@storybook/addon-docs`,
`@storybook/addon-a11y`, `@storybook/addon-vitest`, `@storybook/addon-themes`.

**`vitest` and every `@vitest/*` package pin to 4.1.11.** Not a preference — a
trap. `storybook init` writes `"vitest": "latest"`, which resolves to 5.0.1,
outside `addon-vitest`'s `^3||^4` peer range; Bun does not enforce peers so it
fails silently, and under Vitest 5 `toMatchScreenshot` breaks. Also
`@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8` at
4.1.11, `playwright` 1.63.0, `@tailwindcss/vite` 4.3.3.

Do **not** install `addon-essentials`, `addon-interactions`, `addon-controls`,
`addon-viewport`, `@storybook/test` or `@storybook/blocks` — all folded into core
in Storybook 9. `@storybook/test-runner` is superseded by the Vitest addon.

**D7 — Story format is CSF Next**, not CSF 3. It is Preview (not Experimental)
in 10 and becomes the default in Storybook 11 next Spring; codemods exist both
directions; formats may be mixed across files (not within one). Starting a new
library on the format that is about to become default beats starting on the one
that will need a codemod. The whole `defineMain` / `definePreview` /
`preview.meta` / `meta.story` chain was verified end-to-end under Bun.
`Story.extend({...})` composes stories — args shallow-merged, parameters
deep-merged, decorators and tags concatenated — which suits a chat kit well:
`Message` → `MessageStreaming` → `MessageStreamingWithTools` as a chain.
Do **not** use `Story.test()` — still Experimental behind a feature flag.

**D8 — a11y gates at `error`, not `todo`.** `parameters.a11y.test: 'error'` in
preview. The default scaffold writes `'todo'`, which is silent in CI — verified
by making an `<img>` without alt correctly fail.

**D9 — run the whole story set in both themes** via `initialGlobals: { theme }`
as two Vitest projects. This is the single best lever for a chat kit: axe then
catches dark-mode contrast bugs with no extra stories written. Note this presumes
the design introduces a light mode; if it stays dark-only, this collapses to one
project.

**D10 — visual regression ships in wave 2, not wave 1.** D2 stands — self-hosted
VR via Vitest 4's `toMatchScreenshot` called from a story's `play` is verified
working (run 1 writes the baseline, run 2 compares). The cost is that baselines
are named `-chromium-linux.png` and rendering is not deterministic across
environments, so *both* local baseline generation and CI must run inside
`mcr.microsoft.com/playwright:v1.63.0-noble`. That is real infrastructure. Ship
interaction + a11y first; add VR once the component set has stopped moving,
which also avoids churning baselines during design iteration.

**D11 — adopt `@storybook/addon-mcp@10.6.0` (Preview) and `sb.mock`.**
- `addon-mcp` serves an MCP endpoint at `localhost:6006/mcp` while `storybook
  dev` runs, with `docs` / `development` / `testing` toolsets, so an agent reuses
  the real components instead of inventing markup and can run and self-heal its
  own interaction and a11y tests. Needs `features: { componentsManifest: true }`.
  Given that this repo's entire premise is agent-operated software, and that D3
  is about components an LLM drives, this is the most relevant thing in the
  release. Install it via `bunx storybook add @storybook/addon-mcp` — its
  postinstall hook does not resolve under Bun during `init`.
- `sb.mock` is Storybook's own module mocking, and unlike `vi.mock` it works in
  **static production builds**. For a chat kit this is the difference between
  being able and unable to demo streaming states in the deployed Storybook.

**D12 — omit `.storybook/vitest.setup.ts`.** The published docs snippets still
show `setProjectAnnotations` there, but the addon applies it automatically since
10.3 and the 10.6 scaffold emits no `setupFiles` at all.

**Tailwind v4 trap to verify against, not assume past:** Tailwind v4 silently
emits *zero* utilities for components in a sibling workspace package — preflight
present, utilities absent, build exits 0. The fix is an `@source "../<pkg>/src";`
line. Under D1 the components and the Storybook share one package so this may not
bite, but any story that renders a `ui-react` component will hit it. Verify by
grepping the built CSS for an actual utility class, never by a green build.

Also worth reading before we write our own story conventions: Storybook ships its
own agent skills, `bunx storybook skills` (`stories`, `write-story`, `setup`).

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

### A real bug found on the way

`registerBuiltinRenderers()` guards itself with a module-level
`let registered = false` that `resetToolRenderers()` does **not** clear. One
story calling reset therefore permanently un-registers the builtins for every
other story in the same docs-mode page. This alone justifies making the renderer
registry instance-scoped with a module default.

### Sequencing — 10 steps, each leaving the tree green

S1 registry instancing → **S2 root + store factories (load-bearing, judgement)**
→ S3 thread the root through non-React code (bulk) → S4 api/config injection
(bulk) → S5 create `ui-kit` **and add it to `scripts/build.ts` and
`scripts/publish.ts` in the same commit** → S6 the six fetch-on-mount splits
(judgement — a bulk pass would flatten `AddPanel`'s epoch guard) → S7
store-coupled splits (bulk) → S8 Storybook → **S9 first real in-chat component,
a `CONTRACT:` commit** → S10 remove the shim at 1.0 (major).

Only S9 touches the compatibility contract.

## 2026-09-15 — what "no new seams" actually forbids (asked; clarified)

The rule's sources are `AGENTS.md` ("Hard rules"), `ROADMAP.md` bind #2, and
`docs/extending/README.md`. Read together they are narrower than the slogan.

**A "seam" in this repo is a specific, named mechanism**, defined verbatim in
`docs/extending/README.md`:

> A typed interface in a core package → config accepts a built-in name (string)
> OR a passed-in implementation (value) → optionally shared as an npm package.

That is a *public pluggability surface for third parties*. The rule is an
anti-over-abstraction rule about what outsiders can swap, and the not-pluggable
list is about product identity (SQLite + FTS5 + sqlite-vec, markdown + git as
source of truth, the frontmatter model).

**It therefore does not bind internal structure.** A `BrainUiProvider`, store
factories, a container/presentational split, and injecting `api`/config as
values are not seams under this definition: nothing lands in `brain.config.ts`,
nothing resolves from a registry, nothing is advertised for third-party
implementation, nothing goes in `docs/extending/`. Refactoring for testability
is not the thing the rule was written to stop.

**Where it does bite**: introducing something like a `DataSource` interface that
config accepts and third parties implement. The state proposal refused exactly
that and was right to.

**Two facts that further widen the latitude here:**

1. `ToolRenderer` is *already* a sanctioned seam — `docs/extending/README.md`
   lists it among the four `@schlessera/brain-ui-sdk` seams, with its resolution
   order documented (backend-scoped name → global name → scored predicate →
   generic fallback). The D3 in-chat component work therefore **extends an
   existing seam rather than adding one**. Green light, not a rule collision.
2. `ROADMAP.md` bind #7: extension interfaces are `@experimental` until 1.0, and
   `docs/extending/README.md` repeats it. Pre-1.0, reshaping a seam is a
   CHANGELOG entry, not a major-version fight.

**And the rule cuts both ways.** Its own strongest evidence is `SiteAdapter`:
without a seam that was actually load-bearing, `module-jobs` grew a *second*
scraper with its own site registry and its own browser client, and implemented
one site twice. The rule's real target is speculative abstraction, and it argues
just as hard *for* an interface that is carrying real weight.

**Corrected 2026-09-25.** `SiteAdapter` carries less weight than this says. No
production adapter implements it: `module-jobs`' ten boards implement that
module's own `ScraperAdapter` ([verified pre-migration declaration](https://github.com/schlessera/brain-kit/blob/7a7bd9caff1453abaceddc98826b652f2ca955cb/packages/module-jobs/src/types.ts#L147-L170)) and do not run through
`runAdapters`. The seam is exported and documented, not yet load-bearing.

**2026-09-30 — Implementation context.** The 2026-09-25 correction above
records the pre-migration split. Under #344's adoption ruling, all ten boards
now implement the shared seam and production calls its runner; see the
[adoption decision](site-adapter-adoption.md). The second-implementation bar
and the rule against speculative seams remain binding.

**D14 — the test we apply from here.** Not "is this new?" but: does this
interface exist so a *third party* can substitute an implementation? If yes it
is a seam, needs the second-implementation-within-a-year bar, and belongs in
`docs/extending/`. If it exists so *our own* code can be assembled, tested, or
rendered in two places, it is internal structure and the rule is silent on it.
`ROADMAP.md` says reopening a bind needs a reason that did not exist when it was
made. We are not reopening bind #2 — we are reading its scope correctly.

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
`protocol.ts:45` states additions do not bump the rev, only semantics changes
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
> [current registration](../../packages/ui-react/src/components/chat/renderers/index.ts)
> relies on registry deduplication. The audit is evidence for the fix, not an
> outstanding failure in current registration.

**The renderer bug is real and was reproduced**: register → resolve (non-null) →
reset → register → resolve (**null**). `registered` in
`components/chat/renderers/index.ts:10` is never cleared by
`resetToolRenderers()` (`resetToolRenderers`,
`ui-sdk/src/client/renderers.ts:184`). The existing
`registration-on-mount.test.tsx` sidesteps it by running in separate Bun child
processes — an isolation workaround, not a test of recovery. Fix this in S1.

### Status

D13 is **ratified with the six corrections above folded in**. The architecture
stands; three of its supporting numbers did not survive contact, and one of its
code sketches is type-incorrect.

## 2026-09-15 — D15: the default-root shim is a type-design bug, not a migration aid

On the six sites that "compile and are wrong": *that sounds like a bad type
design.* Correct, and it invalidates the shape of D13's shim rather than just
its details.

A default root that any `useXStore.getState()` silently resolves against is a
design in which **the wrong thing typechecks**. Marking those six call sites as
"real work, watch out for them" is a code-review promise, and code-review
promises do not survive a refactor of this size. If provider-scoped code can
reach the default root without saying so, someone will, and nothing will fail.

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

### Consequence for sequencing

D13's S2/S3 split changes. "Thread the root through non-React code" stops being
a mechanical bulk step that can lag behind — it is the step that *earns* the
type safety, and it lands with or immediately after the store factories. The
lint ban is what holds the line afterwards, and it is cheap to write.

### The general rule this sets

Prefer making the wrong state unrepresentable over documenting it. Any place
this refactor is tempted to say "these N call sites need care", stop and ask
whether the type can refuse them instead. A migration that relies on vigilance
at 55 call sites is not a migration, it is a bet.

## 2026-09-15 — viewport and the accessibility gap (maintainer)

**D16 — Mobile-first, responsive up.** Port at the design's mobile fidelity, but
components are fluid: no hardcoded 390px, nothing that breaks in a wide
container. Stories carry a mobile viewport by default plus a desktop one.

Consequences:
- **`PhoneFrame` becomes a Storybook decorator, not a shipped `ui-kit`
  component.** It is a device mock for presenting screens, not a thing the app
  renders. It still gets ported — as story furniture.
- Desktop-only chrome that exists in `ui-react` today and has no design
  counterpart — `side-rail.tsx`, `slide-panel.tsx`, the desktop file browser —
  **stays in `ui-react`** and is designed later. It is explicitly out of scope
  for step 1 under D4.
- Every component's styles must survive a container wider than the design ever
  showed. That is the one place we knowingly extrapolate beyond the mockups.

**D17 — Port faithfully first; close the accessibility gap in a dedicated pass.**
The design has no focus or hover states at all ("the mockups are touch-only
screens" — its own known-gaps list). Rather than invent them inline while
porting, wave 1 stays honest to the design and the focus system lands as its own
wave before step 2.

**This amends D8.** `parameters.a11y.test` starts at `'todo'`, not `'error'`.
That means **CI is not actually gating accessibility until the a11y wave lands**
— `'todo'` is silent in CI, which is exactly the trap the Storybook research
flagged. Two things follow, and both are requirements, not suggestions:

1. The a11y wave is a **blocking prerequisite for step 2**, not a nice-to-have.
   `ui-react` must not start consuming `ui-kit` while the kit's a11y is
   unenforced.
2. Flipping `'todo'` → `'error'` is the wave's definition of done, and the
   commit that flips it must show CI failing on a seeded violation first, so we
   know the gate is real and not merely configured.

What the a11y wave owns:
- One focus-ring token, applied consistently across every interactive component.
- Real semantics: the source attaches `onClick` to plain `<div>`/`<span>` in
  `Button`, `ListRow`, `ChoiceOption`, `FileRow`, `QueueItemRow`, `FilterRow`,
  `Surface`, `Toggle`, `Disclosure`, `SuggestionChips`, `InlineToast`,
  `Placeholder`, `TabBar`, `AttachmentRow`, `LinkPreviewCard`, `RelatedFiles`
  and `FeedbackRow`. Each needs a real button/role, keyboard activation, and an
  accessible name.
- Contrast re-check of the ink ramp. The design states `#8a8691` is 5.10:1 on
  surface and calls it "the floor" — worth verifying with axe rather than
  trusting the note, especially for the 9-10px mono type it is used on.

## 2026-09-15 — fixture data must be wholly artificial (maintainer)

Requirement: **every piece of test, Storybook, CI, local-dev and example data is
artificial.** No real personal data and nothing from the real knowledge base, at
any point, in any of those places. Options researched in
a fixture-world options pass; the world chosen was the Odyssey (D19).

Three findings that are settled regardless of which world wins.

### The design drop already ships real brands

Its mock content is not neutral. `Nordwind` — the client name, used 9 times — is
a real Moscow-headquartered airline (verified). `LX Factory` is a real Lisbon
venue and the design uses its true coordinates. `daily.dev` and `Tailscale` are
real products, and AGENTS.md separately bans tailnets as personal
infrastructure. **These get replaced during the port, not after.** A porting
agent copying mock content faithfully would carry all four into a published
package.

### The leakage gate constrains VOCABULARY, not names

Measured, not guessed: candidate strings were run through the repo's own
`leakagePattern()`. **9 of 23 tripped, and not one was a character name.** Every
collision came from prose register — what a world lets you *describe*, not who
it lets you name. Matching is case-insensitive substring, per line, so a banned
token only has to appear *inside* a longer word: base forms pass where their
inflections trip.

The collision classes, named without quoting the strings (quoting them here
would fail the gate — that already happened once):

- plumage and colour description in wildlife prose — one banned token is
  standard ornithological vocabulary and appears in official species common
  names
- seasonal-singing words in their `-ed` / `-er` / `-ers` inflections, though not
  in base or plural form
- one Stuart/Restoration period adjective
- heraldic and fantasy bestiary terms, including as a codename
- one common French masculine given name

**Style rules that follow, and they apply to all fixture prose forever:** prefer
plain sightings over plumage description; avoid Stuart-era and heraldic
register; check any French given name; and run a candidate cast and its
vocabulary through the gate *before* adopting it, not after writing the fixtures.

This also inverts the earlier assumption that any world with a clean canon is
safe. The exposure is uneven and it is about subject matter: a world whose
persona does seasonal wildlife survey work is badly exposed even though its cast
is invented.

### The corpus cost model is the opposite of what we assumed

Measured against `packages/core/fixtures/`:

- **Renaming the persona is cheap.** 33 files mention it, but 13 are tests whose
  uses are self-contained literals (an RSS `<dc:creator>`, an
  `x-forwarded-user` header, a `{name, role}` object) rather than assertions
  about corpus content. `brain.db` is **not tracked**. There are no snapshot or
  golden files anywhere.
- **Adding to the corpus is expensive.** `packages/core/fixtures/README.md`
  documents *global invariants*, not sample documents: exactly two intentional
  unresolved links; exactly one orphan (`notes/loose-idea.md`), which the orphan
  test depends on; engineered basename ambiguity; and staleness windows computed
  against a pinned date with asserted day counts. Adding people, invoices and
  venues creates new orphans, new unresolved links and new ambiguous basenames —
  each one an existing assertion.
- **A period world would force re-dating the entire corpus.** The pinned 2026
  reference date is load-bearing for every staleness, index-lag and propagation
  assertion, and an 1872 or 1889 setting cannot host it. That cost is larger
  than any of the IP risks.

> **2026-09-30 — Corpus ruling.** D18’s separate-persona and no-shared-content restrictions are historical.
> [One Odysseus world](example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

**D18 — the corpus and the kit fixtures are separate, and neither moves the
other.** `packages/core/fixtures/corpus/` stays exactly as it is, persona
included: zero test churn, invariants intact, pinned date intact. `ui-kit` gets
its own fixture world under `packages/ui-kit/fixtures/`, free to be whatever we
choose, because nothing asserts global invariants over it. The two never meet.

This also dissolves the apparent conflict with AGENTS.md's "Alex Example" hard
rule: that rule governs the corpus, which is unchanged. If the kit's world uses
different names, AGENTS.md gains a sentence scoping the personas — a deliberate
edit in the same commit, not a silent divergence.

## 2026-09-15 — D19: the fixture world is the Odyssey (maintainer's choice)

**Decided: Odysseus is the owner of the demo second brain.** Used everywhere
artificial data is needed — `ui-kit` fixtures, Storybook, website copy,
screenshots, demo videos.

### Why it beats every researched option

- **IP risk is the floor and then some.** Homer is public domain in every
  jurisdiction on earth, with no estate, no licensing body, and no trademark on
  the cast. This is strictly safer than the RFC-reserved option, which still
  needs care around company names, and far safer than the "documented company"
  placeholders, where `CONTOSO` is a live Microsoft registration whose recited
  services literally cover simulated case studies.
- **The graph already exists.** People with real relationships, places, goals,
  conflicts, journeys, promises, memories, and — the useful part — a great many
  *unresolved* problems. The story is structurally a backlog: hostile
  stakeholders, dependencies, travel logistics and consequential bad decisions.
  Demo data can be dramatic without looking arbitrary.
- **Instantly and unmistakably fictional**, which is the property that makes
  real data leaking in obvious.
- **The geography is real.** Ithaca, Troy/Hisarlik and the Strait of Messina are
  actual places with actual coordinates, so `MapView`'s Web Mercator projection
  and computed scale bar draw a correct map. Mythical locations have
  conventional real-world candidate sites (Ogygia → Gozo, Scylla → Scilla in
  Calabria), so even those can be pinned honestly.
- **It hosts 2026 dates without strain.** Unlike Baker Street 1889 or Verne
  1872, the anachronism *is* the conceit, so no fixture needs re-dating and the
  corpus's pinned-date problem never arises.

### Gate check — run before adopting, per the standing rule

139 candidate strings were probed through the repo's own `scanText()` from a
script kept outside the scanned tree. **125 Odyssey strings across cast, gods,
creatures, places and nautical vocabulary: all clear.** The only two trips were
control strings planted deliberately to prove the probe actually detects
something.

One residual hazard worth naming, because the Odyssey walks right past it: the
poem is full of **bird omens** — eagles, a hawk, the geese in Penelope's dream.
One banned token is a plumage-colour word. Describe birds plainly ("an eagle
carrying a goose"), never by plumage colour.

### The tone rule

**Ancient problems, modern organisational tools.** Odysseus with a smartphone,
everything else mythologically grounded. No modern job titles, no invented
startup, no "Project Atlas". The humour comes from the collision being played
straight — "Call Penelope — overdue by 10 years" works precisely because the
surrounding data is serious. **Parody is a failure mode here**, because a
fixture set that is winking at the reader stops being usable for screenshots
and demo videos.

Mapping (from the maintainer's brief):

| Feature | Fixture content |
|---|---|
| Goal | Return to Ithaca |
| Project | Get home after Troy |
| People | Penelope, Telemachus, Athena, Circe, Calypso, Poseidon |
| Places | Ithaca, Troy, Aeaea, Ogygia, land of the Cyclopes |
| Open loops | Crew safety, Poseidon's anger, supplies, route home |
| Notes | "Do not tell Polyphemus my real name" |
| Tasks | Repair mast, replenish water, avoid Scylla, check winds |
| Journal | "Day 2,914 away from home" |
| Reminders | "Tie me to the mast before the Sirens" |
| Knowledge | Sirens — dangerous vocal lure; wax recommended |
| Decisions | Scylla vs Charybdis |
| Relationships | Athena — ally, intervention unpredictable |
| Search | "Where did Circe warn me about Scylla?" |
| AI summary | "What happened since leaving Troy?" |
| Maps | Route across the Mediterranean |
| Attachments | Charts, sketches, ship manifests |
| Tags | #ithaca #crew #gods #danger |

> **2026-09-30 — Corpus ruling.** D19’s former UI-only scope is historical.
> [One Odysseus world](example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

Scope: `packages/ui-kit/fixtures/` per D18. `packages/core/fixtures/corpus/` and
its "Alex Example" persona are untouched, so no test churn and no invariant
breakage. AGENTS.md gains a sentence scoping the two personas — corpus vs kit —
in the commit that introduces the world.

## 2026-09-15 — the design drop gained interaction states, light theme and desktop

The Claude Design project was updated mid-build. Three of the deferrals we made
because the design lacked something are now obsolete, because it has it.

**New files**: `kit/Brain Kit Light.dc.html`, `kit/Brain Kit Desktop.dc.html`,
`kit/SideRail.dc.html`, `kit/CommandPalette.dc.html`, `kit/browser-window.jsx`.
**Component count 56 → 58.** The kit README gained three sections: "Interaction
states & accessibility", "Light theme", "Desktop".

Diffed v1 against v2: of the twelve primitives, exactly three changed —
`Button`, `Toggle`, `Icon`. The other nine are byte-identical. The remaining 44
components have not been re-fetched yet; the README's claim that "every
interactive component ships hover, pressed, focus and disabled" means the
interactive ones among them have almost certainly changed too, and waves 2-4
must re-fetch before porting rather than trusting the copies on disk.

### D20 — supersedes D17: port the interaction states, do not defer them

D17 deferred focus and hover because the design had none and I did not want them
invented. That reason is gone. The design now specifies all four states with
exact values, a role-and-keys table for nine component groups, and five
non-negotiable rules. Porting without them would mean deliberately discarding
part of the source.

The specification, verbatim enough to implement against:
- **Hover**: surface one step up (`#1a1d22`), border to `#3a3e47` on controls.
  The tone never changes — "a control that looks like something else on hover
  has lied about what it does".
- **Pressed**: `translateY(1px)` + `brightness(.94)`. No colour change, no ripple.
- **Focus**: 2px `#e8e4df` outline, offset **+2 on controls / −2 on full-width
  rows** so nothing clips it. Ink, not amber or teal, because focus says *where
  you are*, not what a thing means. `:focus-visible`, not `:focus`.
- **Disabled**: `opacity .45` + `pointer-events:none` + `aria-disabled`, plus a
  mono line saying *why*.
- **Interactive treatment appears only when a handler is passed** — a row with
  no `onClick` is not focusable and gets no hover, so a static list never
  pretends to be clickable. This is an API contract, not styling.

Mechanism: per-tone values travel as `--hv-bg` / `--hv-bd` / `--hv-fg` custom
properties set in `renderVals()`, because in DC a bound `{{ hole }}` compiles to
an empty rule. That constraint is DC's, not React's, **but keep the mechanism** —
it is exactly what makes the light theme possible: hover values become tokens
like everything else.

The five rules that are not negotiable: never colour alone (a monochrome
screenshot must still parse); a control that writes exposes its effect chip as
part of its accessible name ("Approve this edit, enqueue"); `aria-live="polite"`
on StreamingAnswer's phase line and InlineToast; `prefers-reduced-motion` drops
`breathe` to a static dot; and hit targets are not visual size.

**The hit-target rule has teeth.** 44px minimum on touch, but a 44px *target* is
not a 44px *box* — small visuals stay small and extend their target past the
paint. The constraint: expansion per side must be ≤ half the distance to the
nearest interactive neighbour, so a row of expanded targets needs `gap` ≥ 2× the
inset. The README records what happens otherwise: a neighbour's invisible
pseudo-element sits on top of your visual and steals the click, and
`FeedbackRow` briefly recorded thumbs-down for a thumbs-up. **Verify with
`elementFromPoint` at each target's edges, not its centre.**

Still deferred to the a11y wave: components that do not yet ship states, axe
verification, and flipping `parameters.a11y.test` from `'todo'` to `'error'`.

### D21 — revives D9: the two-theme test matrix is real again

A full light theme now exists with a published token contract, so
`initialGlobals: { theme }` across two Vitest projects is back on. The important
part is that **a light theme is not the dark theme inverted** — every dark
accent was chosen to glow against `#0c0e12` and collapses on paper (amber is
2.2:1 against white, gold 1.8:1). The rule is *hue carries the meaning,
lightness carries the contrast*.

**Accents carry two values in light mode**, where dark needed one: a darkened
**ink** for text, icons and borders, and the original **fill** for solid
surfaces that take near-black text. Fill-as-text is illegible; ink-as-fill turns
the primary button to mud. Small marks need a third step — at 6-8px a darkened
accent reads black, so status dots use a mid value. Tints use the *fill* hue at
8-14%, never the ink hue, which reads as dirt. Alpha ink stays banned in both
themes, and the focus ring is ink in both.

Implementation is exactly what we already instructed: each component's tone map
is the only place a colour literal appears, and that is the seam. Route through
custom properties on a `[data-theme]` root. Default to `prefers-color-scheme`,
keep an explicit three-way toggle (system / paper / dark).

### D22 — amends D16: desktop comes into the kit

D16 kept desktop chrome in `ui-react` because the design was mobile-only. The
design now has two full desktop layouts and two new components, so `SideRail`
and `CommandPalette` join the kit and the breakpoint ladder is specified:

| Breakpoint | Nav | Layout |
|---|---|---|
| ≤ 479 phone | TabBar, 5 slots | one pane, pushes |
| 480-899 tablet | SideRail collapsed (60px) | list + detail |
| 900-1279 laptop | SideRail expanded (208px) | list + detail |
| ≥ 1280 desktop | SideRail + ⌘K palette | rail + list + detail + evidence |

Same component files as mobile; only frame and density change. Body 13.5 → 13px
(meta stays 9-12px mono); serif titles step 17 → 19 → 21 per pane width; answer
prose caps at **720px measure** however wide the window; StatTiles 3-up at 720px
and 4-up past 1100px; ComparisonTable may take a fourth column past 1100px,
never at 390px. Desktop may reveal *secondary* actions on row hover — never
state, provenance or effect chips, because those are what the row means. Focus
order is rail → list → detail → composer, and a resolved decision moves focus to
the next list item, never to the top of the document.

What never scales: one primary action per pane, one ambient animation, two
background colours, and the effect chip on anything that writes.

Mobile-first still holds as the authoring order, and `PhoneFrame` stays a
Storybook decorator — `browser-window.jsx` presumably becomes its desktop
counterpart.

> **2026-10-06 — Amended by [D52](#2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943).**
> At ≥ 1280, Chat's list pane is the Sessions pane, with `New conversation`
> as its one primary action and Working above its date groups. Below 1280, a
> row between the transcript and the composer carries working sessions in its
> left half and pending follow-ups in its right half (right half only at
> ≥ 1280). It is a sibling, not an overlay, at most 94px tall and 44px while
> composing, and nothing in it animates. The ladder, the hover rule, one
> primary action per pane and the one ambient animation still bind.

### Also noted
- `Composer` is a display component in the design — a styled span, not a live
  input. The README says to wire it to a real `<textarea>` with `:focus-visible`
  when implementing. That is net-new work, not a port.
- Desktop covers Chat and Actions only; Files, Activity and Settings at desktop
  width are unbuilt, so those screens have no desktop design yet.
- The light theme is specified and proven but **not yet wired into the
  components** — their tone maps still hold dark literals. The README calls
  routing them through `[data-theme]` custom properties "the implementation
  step", which is precisely what we instructed wave 1 to do.

## 2026-09-15 — D23: the kit's stylesheet is mandatory, not optional

Every colour in `ui-kit` resolves through a CSS custom property. No `.tsx` in
the package contains a colour literal; each component keeps its `T`/`C` table
with the design's vocabulary (`amber`, `teal`, `fg`, `border`, `tint`) and every
value in it is a `var(--…)`.

**Consequence, stated plainly: a consumer who does not load `styles.css` (or
pull `theme.css` into their own Tailwind build) gets components with no colour
at all.** That is a real cost for a published package and it is deliberate.

I originally asked for `var(--token, #hex)` fallbacks so a stylesheet-less
consumer would still render. That was wrong, for a reason I had not considered:
**a light-theme consumer who fails to load the stylesheet would get dark
defaults.** "No colour" is a loud failure that gets fixed in minutes; "subtly
wrong theme" is a quiet one that ships. Fallbacks would also put the literals
back in source and mask the missing stylesheet entirely. Documented at the top
of `index.ts`, `tokens.ts` and in the changeset.

`tests/token-references.test.ts` enforces both directions: every `var(--…)` in
`src/` must be defined in `theme.css`, and no source file may contain a hex,
`rgb(`, `hsl(` or `color-mix(`. Worth understanding why that test earns its
keep — **the failure mode moved**. A hex typo renders the wrong colour loudly; a
token typo renders *no declaration at all*, which can look plausible.

### The alpha ramps are three sets, not one

Chip tints at 9-10%, Callout at 6-8%, Surface at 5-6%. These are the design's
own numbers from its `T` maps. Collapsing them to a single tint would have been
a silent redesign, so the band rule is documented and the three points within it
are preserved.

### Open: relative colour syntax is outside the package's baseline

The derived tokens were built with `rgb(from var(--color-amber) r g b / 0.1)`.
Verified against caniuse: **relative colour syntax shipped in Chrome 119, with
full support in Chromium 125+ and Safari 18.0+** — outside Tailwind v4's
Chrome 111 / Safari 16.4 floor, which is the baseline this package otherwise
claims. Exposure is small in practice (Chrome 111 is March 2023, 125 is May
2024), but this is published CSS in an npm package rather than an app we
control.

The benefit is also smaller than it first appears: the payoff of derivation is
"redefine the 14 base colours and every tint re-derives", but the light contract
explicitly wants *different* alphas (tints use the fill hue at 8-14%, never the
ink hue), so the second theme overrides the derived tokens anyway. Direction
given: precompute the 60 derived tokens as literals in `theme.css` unless there
is a counter-argument. They stay tokens, stay in one place, stay overridable —
only the derivation mechanism goes, and `theme.css` is where literals belong.

### Naming rule established

`#7fd0be` served as both `affirm`'s hover fill and the teal meter gradient's
stop. Renamed `--color-teal-lift` — **named for what it is, not where it was
first used.** Free at one call site, expensive at twenty. The ~18 hover tokens
wave 1b needs follow the same rule.

### D24 — `Button.disabled` is ported but INCOMPLETE

Wave 1 ported `disabled` (the visual rest state: `opacity .45`,
`cursor:not-allowed`, `pointer-events:none`) while leaving `role`, `tabIndex`
and `aria-disabled` to the accessibility wave. That split is sound — the
component has no keyboard path at all yet, so the semantics half would have
nothing to suppress, and a declared prop silently missing from the kit is the
worse failure.

**But it must not be recorded as done.** A wave-1b checklist reading "disabled:
ported" invites skipping the `aria-disabled` half, and a visually-disabled
control with no programmatic signal is exactly the bug an accessibility wave
exists to prevent.

## 2026-09-15 — D24 is superseded: `Button.disabled` is complete

D24 said `disabled` was ported but incomplete, and required the plan to record
the semantics as outstanding. **That was correct when written and is now wrong.**
Porting the interaction states in the same round brought the other half with it:
`aria-disabled`, `tabIndex={-1}` and the `role` the attribute needs in order to
qualify anything. Verified in the source — `aria-disabled` renders gated on
`interactive && disabled`, and the `Disabled` story asserts it.

Leaving the D24 note in place would have sent wave 1b hunting for work that is
finished. **Wave 1b's list is the nine components that have no states at all** —
a different list. The nuance worth keeping: `aria-disabled` appears only when a
handler was passed, because without one there is no `role="button"` for it to
qualify, and a bare `aria-disabled` on a `div` means nothing.

The general principle behind D24 still stands and is worth restating, since it
will apply again: **a half-ported feature must be recorded as half-ported**, or
a later wave reads the checklist and skips the missing half.

## 2026-09-15 — Wave 1 closed

12 primitives, 115 tokens, `--bk-` prefixed. Verified independently: `tsc`
clean, six lint gates clean, 2753 pass / 24 skip / 0 fail, `storybook build`
green, 85 storybook tests in real Chromium, leakage clean, `check-dist-types`
clean, api-report regenerated.

Decisions made inside the wave that bind later ones:

- **`sc-host`: no wrapper — the component's own root is the flex item.** The DC
  wrapper was a plain block div, so every `flex` / `width:100%` / `boxSizing`
  the design wrote on a component root was inert. Dropping it makes those
  declarations do what their author wrote them to do. Consequence decided once:
  `inline-flex` roots blockify (visually identical; containers use
  `alignItems`), and a component needing host positioning gains a `style` prop
  merged onto its root.
- **`@theme` must be `@theme static`.** Without it, Tailwind v4 prunes every
  design token out of `dist/styles.css` when no source file uses a utility
  class — shipping a palette-less kit to any consumer who does not run Tailwind.
  Found by grepping the built CSS, not by a green build. Asserted by a test.
- **No `var(--token, #fallback)` anywhere** (D23). Verified the failure is
  genuinely loud: with stylesheets disabled, a primary Button goes
  `rgb(224,159,62)` → `rgba(0,0,0,0)`. Nobody ships that by accident.
- **Name a token for what it is, not where it was first used.** Applied to the
  18 hover tokens immediately rather than deferring — 12 turned out to be an
  existing colour under a second name and now say so
  (`--bk-button-hover-bg-ghost: var(--bk-color-raised)`). `--bk-hover-surface`
  was deleted outright as a duplicate of `raised`: **a second name for one
  colour is how two colours start.** The primary button lifts to
  `--bk-color-amber-lift`, *not* to gold — identical value in this palette, but
  "amber one step up" is what the hover means, and a theme that moved gold must
  not drag the primary button's hover behind it.
- **A token that refers to another must name one that exists** — asserted by a
  test, because an undefined reference inside a token renders nothing and the
  element quietly inherits. The three-level chain was confirmed resolving in a
  real browser: `--hv-bg` → `--bk-button-hover-bg-primary` →
  `--bk-color-amber-lift` → `#eab354`.
- **Keyboard activation is part of porting a role.** A `role="button"` that
  cannot be operated from the keyboard is worse than no role.
- **The DC parity harness lives at `packages/ui-kit/tools/dc-parity/`** and is
  runnable. It serves the real `.dc.html` under the real DC runtime and diffs
  computed styles node-by-node against the built Storybook. Later waves use it.

## 2026-09-15 — D25: MapView gets real coastline geometry, not tiles

Maintainer's constraint: the map stays **static — no panning, no zooming** — but
must be **recognisable**, not the "radar view" the graticule alone produces.
Research and measurements in [map-geometry.md](map-geometry.md).

**Decision: ship simplified OSM coastline as fixture data and let `MapView`'s
existing projection draw it as SVG polylines.** No tiles, no network at render
time, no key, no new dependency.

This is **not a rule change**. The design already writes the escape hatch:
*"street and coastline geometry only ever appears if the app passes real
[lon,lat] paths."* We are using the sanctioned path, through machinery the
component already has.

### Natural Earth is out — measured, not assumed

Public domain and attribution-free, so it was the preferred answer on paper. It
fails on resolution. Vertices were counted inside each fixture bbox and median
segment length converted to pixels at 348px:

| Location | span | m/px | NE 10m verts | median segment |
|---|---|---|---|---|
| Ithaca | 20.9 km | 60.1 | 51 | 1 281 m = **21.3 px** |
| Gozo | 18.0 km | 51.7 | 19 | 1 675 m = **32.4 px** |
| Corfu | 51.5 km | 147.9 | 128 | 1 296 m = **8.8 px** |
| Messina | 23.6 km | 67.9 | 33 | 2 397 m = **35.3 px** |
| Troy | 29.9 km | 85.8 | 15 | 1 103 m = **12.9 px** |

Recognisable coastline needs **2-4 px** segments; NE 10m is 5-10× too coarse —
fifteen vertices for the whole Troy shoreline. Natural Earth's own spec agrees:
islands under 2 km² go in a separate file, because 10m is built for continental
scale. **Public domain and still unusable.**

### OSM coastline, simplified — measured

Raw Overpass coastline is ~100× over-detailed (Ithaca: 4 482 vertices, 312 KB,
median segment 0.45 px). Douglas-Peucker at **1 px of the target render**:

| Location | raw verts | simplified | JSON | gzipped |
|---|---|---|---|---|
| Ithaca | 4 482 | 735 | 13.0 KB | 3.2 KB |
| Gozo | 6 755 | 441 | 7.7 KB | 2.0 KB |
| Corfu | 22 141 | 1 293 | 23.3 KB | 5.6 KB |
| Messina | 5 074 | 211 | 3.7 KB | 1.1 KB |
| Troy | 996 | 131 | 2.3 KB | 0.7 KB |
| **all five** | | **2 811** | **50 KB** | **12.6 KB** |

Tolerance sweep on Ithaca: 0.5 px → 4.8 KB gz, 1 px → 3.2, 1.5 px → 2.6,
2.5 px → 2.1. **1 px is the knee.** For scale: one raster map tile is ~16 KB, so
**the entire five-location vector set is smaller than a single tile.**

Verified by rendering, not by reasoning: drawn at exactly 348×170 through
MapView's own Mercator maths and screenshotted headless in both themes. Gozo is
unmistakable, Messina reads as a strait, Troy reads as a coast. **Dark and paper
are the same data rendered twice** — which is the entire argument against raster,
where each theme needs its own baked image set (400-700 KB, two asset sets).

### Ship stroke-only first; fill is a real trap

An outline alone is ambiguous — it does not say which side is land, and filling
is a large legibility gain. But filling needs closed rings, and **mainland
coastline never closes inside a bounding box**: Messina and Troy yielded zero
closed rings from 21 and 26 ways. Hand-rolled viewport closure was tried and
**got three of five wrong** — diagonal seams and inverted land/sea on Corfu,
Ithaca and Messina. The concept is sound; ad-hoc clipping is where it breaks.

So: **stroke-only first**, because it needs no clipper and `paths` renders it
today. Fill later via already-assembled land polygons
(`osmdata.openstreetmap.de`, which repairs OSM errors in the process) clipped
with `ogr2ogr -clipsrc` or `mapshaper` — a real clipper, not our own.

### Licensing — the distinction that decided this

- **Rendered output is a Produced Work.** The OSMF guideline names SVG and
  raster images explicitly; a Produced Work may carry any licence. So the drawn
  map carries no share-alike.
- **The fixture geometry is a Derivative Database.** It is data, shipped to be
  read as data, so **ODbL share-alike does attach to the JSON.** That needs
  `packages/ui-kit/fixtures/geo/LICENSE` naming OSM and ODbL, plus attribution.

**Verified consequence: the npm package is unaffected.** `packages/ui-kit`
declares `files: ["src", "dist", "README.md"]`, and `bun pm pack --dry-run`
confirms **zero fixture files in the tarball**. The published package stays pure
MIT. The ODbL obligation attaches to the public repository and to the deployed
Storybook, both of which carry the LICENSE and the attribution line.

### What the shipped component does

Keep the projection, graticule and scale bar as the default — "an accurate
locator, not a picture of a map" is still right for one pin in a 348px message.
Coastline arrives through the existing `paths` prop, so consumers supply their
own geometry under their own licence.

### The rule, narrowed rather than overturned

The design's stated reason — *"public tile servers block embedded clients"* — is
**factually wrong** and should be removed: OSM's policy says modern browsers in
standard configuration pass all technical requirements. The conclusion survives
on three stronger grounds:

1. **A browser component cannot set a `User-Agent`**, and OSM §3.4 treats a
   published library as an SDK that must identify itself. Every consumer would
   sit in one anonymous bucket. Both policies also say never hardcode the tile URL.
2. **Every hosted alternative needs a key we cannot commit**, and the free tiers
   needing no key forbid commercial use — which we cannot impose on consumers of
   an MIT package.
3. **Our own CI would violate the policy on every run.** It lists *"headless
   bots that pan/zoom the map to force rendering"* under bulk downloading, which
   is exactly what visual-regression screenshots are.

Replacement rule: **a published component may not fetch map tiles at render
time.** Themed backdrops, if ever wanted, are baked at build time and passed in.

MapLibre is out on determinism rather than size: v6 requires WebGL2 and throws
without it, headless falls back to SwiftShader, and its own render suite needs
`xvfb-run`. No stable visual-regression baseline. A full-screen pannable map is
a legitimate thing to build — **in the app, not in the kit.**

### D25 addendum — Natural Earth's coarser scales, and where geometry runs out

The 1:50m scale was measured after the fact and is **worse, not better**: Gozo
drops to 8 vertices (76 px median segment), Troy to 3 (154 px). At 1:110m, four
of the five locations return **zero vertices** — the islands are not in the
dataset at all. Natural Earth's scales run the wrong way for this use: 10m is
already its most detailed. Comprehensively rejected on detail, which is what
makes OSM *necessary* rather than merely preferred — and therefore what makes
the ODbL obligation unavoidable rather than a choice.

Where coastline alone is enough, measured by rendering each at 348×170:

- **Well served:** Gozo, Corfu, Ithaca — closed island silhouettes.
- **Adequate:** Strait of Messina — two facing coasts read as a strait.
- **Weak:** Troy — a single shoreline curve is ambiguous. The fix is **roads**
  (`highway~motorway|trunk|primary`) through the same pipeline for a few KB more,
  **not a raster**. Same licence position, same theming, same determinism.

Pipeline, for when this is built:
`mapshaper -clip bbox= -simplify dp interval= -o precision=0.0001`, with
`interval = span_metres / 348` (one pixel of the target render), coordinates at
4 dp. Output is already the shape `MapView`'s `paths` prop accepts, so
**stroke-only needs no component API change.**

## 2026-09-15 — the two-button overflow: corrected cause, and a wave-5 hazard

I diagnosed this as `hint-size` masking a latent layout bug. **That was wrong**,
and the real cause is more consequential.

Disproved two ways before the fix was written:

- **In the runtime source.** `hintToMin()` is reached only via
  `r.htmlStreaming ? hintToMin(…) : void 0`, and `htmlStreaming` is `false` in
  the registry's initial record. On a settled render `hint-size` contributes
  nothing — exactly what wave 0 concluded.
- **In the browser.** The DC page's action row was measured: the two
  `div.sc-host` wrappers are **155px and 65px** at `flex: 0 1 auto`. Were
  `hint-size` applied they would carry `min-width: 50%` ≥ 224px. Row
  `scrollWidth` 448 in `clientWidth` 448 — **the DC runtime does not overflow.**

**The actual cause is the `sc-host` decision.** Under DC the flex items were the
*wrapper divs*, and each Button was a block child inside one, so `width: 100%`
resolved against a shrink-to-fit box and came out content-sized. Wave 1 dropped
the wrapper deliberately, and recorded that those declarations "become live,
doing exactly what their author wrote them to do". Here what the author wrote
overflows — **because the author never saw those declarations take effect.**

Wave 1 verified the no-wrapper decision in a flex **column**. Nobody checked a
flex **row**, and a row is where it bites.

### The real lesson — a wave 5 hazard, not a Button bug

**`width: 100%` on a component root is now load-bearing, and nearly every block
component in the kit declares it**: `Surface`, `Placeholder`, `DiffBlock`,
`Receipt`, `DataTable`, `BarList`, `TraceSteps`, `ChoiceOption`, `ListRow`,
`QueueItemRow`, `SearchResultCard`, `ActionCard`, `AskUserCard`, `ApprovalCard`,
`NotificationCard`. **Put any two of them side by side in a flex row and this
recurs.** Wave 5 assembles screens; that is precisely where two components land
in one row. Check it there deliberately rather than discovering it visually.

Deleting `hint-size` remains correct. It was simply never the explanation.

### The fix

`Button` gained an optional `style` prop merged last onto its root — wave 1's own
seam, which also avoided `theme.css` while wave 3 was editing it.
`ApprovalCard`'s two buttons take `{ flex: "1 1 0", width: "auto" }`;
`ActionCard`'s `WithButtons` uses `block={false}`, the content-sized shape
`AskUserCard` already demonstrates.

### Open design question — the even split diverges from DC on purpose

DC actually draws ApprovalCard's buttons **content-sized at 155/65**;
`block={false}` would have been byte-identical parity. The 50/50 split is a
deliberate divergence, kept because the content-sized result is an accident of
the wrapper rather than anyone's decision, and the `hint-size="50%"` annotation
is the only *stated* intent. It shows in parity as one property on two nodes.

Note the ambiguity honestly: in the DC **editor** the designer saw 50/50
(hints apply while streaming); in the settled **catalog** they would have seen
155/65. So both readings have evidence. This is exactly the kind of question the
Storybook exists to settle — flagged for the maintainer rather than silently
resolved.

### The test

`overflowing()` in `stories/_stage.tsx` compares `scrollWidth` to `clientWidth`
*and* names which element escaped. Proven failing first:

```
content is 686px wide inside a 360px box
<div>Skip it overflows the right edge by 326px
<span>Skip it overflows the right edge by 178px
```

This is the general form, not the instance — it will catch the wave-5 hazard
above wherever a story exercises it.

## 2026-09-15 — Wave 3 closed; 46 components

Verified independently: `tsc` clean, six lint gates clean, leakage clean, 2920
pass / 0 fail, brand sweep across `src/ stories/ fixtures/ tests/` empty,
`mapview-projection` 14 pass.

### The design's hit-target numbers are wrong — measured

`inset` on an absolutely positioned pseudo-element resolves against the **padding
box**, so a 1px border eats 1px of reach per side. `FeedbackRow`'s thumb is
**46×42**, not the 48×44 its own source comment claims; `InlineToast`'s undo is
**43.65px** tall, not 44. **Both fall under the design's own 44px floor.**
Wave 1's `Toggle` is correct only because its track has no border.

Deliberately reported rather than silently fixed: `inset: -10px` would need
`gap ≥ 20`, and the design's gap is 18 — so "fixing" it reintroduces the click
theft the gap rule exists to prevent. The stories assert the *real* measured
numbers, and `NarrowGapStealsTheClick` reproduces the theft at `gap: 10` on
demand. **This needs the designer, not a patch.**

### MapView is numerically verified

13 tests including the property that separates Mercator from equirectangular
(vertical stretch = 1/cos φ), pin pixels for Scylla/Charybdis, and the scale
bar's 59px converted back through metres-per-degree. **Two hand-computed
constants were wrong and the component was right** — which is the outcome that
makes the exercise worth doing. DC parity identical on every probed property
including every `top`/`left`.

### D26 — brand replacement stays scoped to actual contamination

A twelfth contaminated fallback was found that wave 2 missed: `TraceSteps` named
the same plausible real person. An earlier pass replaced **all twenty** default
fallbacks with Odyssey content; nine were reverted.

**Decision: keep that revert.** Replace a runtime fallback only where it carries
a real brand or person. The untouched fallbacks stay parity-comparable against
the DC source, and parity is a verification asset we have repeatedly cashed in —
it caught the `sc-host` row hazard and confirmed MapView's projection. Divergence
has a cost and should be paid only where a rule requires it.

**Sharpened by D29 (wave 4), which is where the operative test is stated:** the
question is not "is this in-world?" but "would shipping this string name
something REAL?", and the line is drawn by audience — stories and fixtures are
the demo world and are Odyssey without exception, while a runtime fallback is a
developer-facing default and a parity anchor.

### A real design gap, surfaced by narrowing types

Six tone unions were narrowed, which let 13 fixture shapes re-point at `../src`
and turned `fixtures/types.ts`'s stated guarantee into a compile error. It
immediately caught something a human review would not: **`ContactCard` cannot
express severity in a fact** — its table is the entity palette, with no red or
gold — so "last spoke: 20 years ago" had to settle for amber. Worth fixing in
the design rather than working around.

### Two harness findings worth keeping

- An auto margin cannot be compared without width-matching the containers (cost
  a phantom 920px diff).
- `MapView`'s scale bar is a second instance of wave 1's `Chip variant="count"`
  box-sizing exception — so that is a pattern, not a one-off.
- A grep for `::before` in built CSS reports MISSING because the minifier
  collapses it to `:before`. Check both forms.

## 2026-09-15 — D27: `Disclosure` becomes optionally controlled (maintainer)

**A deliberate divergence from the DC source, and the only one in wave 3.** The
design's component is uncontrolled after first interaction and the port
reproduced that exactly. It now supports a controlled mode as well. Recorded
here because a later reader comparing the React component against the `.dc.html`
will see an extra prop and be tempted to "restore parity" by deleting it; the
component's own doc comment points back at this entry for the same reason.

### Why the design's behaviour is not enough

Two cases in this app are simply unreachable without it, and neither is
hypothetical:

- **A server-driven expand.** A transcript that re-renders because the agent
  said "expand the trace" cannot expand it. The value is in the parent and the
  component refuses to look at it after the first click.
- **An accordion.** A parent rendering several disclosures — the Run-detail
  screen does — cannot collapse the others when one opens, because each holds
  its own state and no parent can reach in.

Both are the same defect seen from two sides: the value lives in the component
and the reason to change it lives outside.

### The shape, which is what keeps this safe

Three modes, and the middle one is the design's, untouched:

| Props passed | Mode | Behaviour |
|---|---|---|
| neither | uncontrolled | starts closed, toggles itself |
| `open` | **seeded** | **the design's exactly** — seeds once, then ignored |
| `open` + `onOpenChange` | controlled | the parent owns the value |

**The presence of BOTH props is what hands over control**, not `open` alone.
That is the whole reason the divergence is cheap: every existing call site
passes only `open`, so every existing call site is bit-for-bit unaffected, and
`OpenPropIsSeedOnly` still asserts the old behaviour rather than being rewritten
to match the new one. Had `open` alone flipped the component to controlled, this
would have been a breaking change to a component the design already shipped.

`onOpenChange` fires on every toggle in all three modes, so a parent can observe
without taking ownership.

### Verification

Four stories, one per mode plus the accordion. `Controlled` asserts the case
that is invisible when you get this wrong: a parent that IGNORES the callback
gets a disclosure that does not open, proving no second source of truth is
quietly holding state alongside the parent's. `Accordion` asserts that opening
one of three collapses the other two, which is the case the change exists for.

### The general rule

A port may diverge from the design where the design's behaviour makes a real
requirement unreachable — but the divergence must be ADDITIVE and gated on a
prop the design never had, so the design's own behaviour remains the default and
stays asserted. Anything that changes what an existing call site does is a
different kind of decision and needs the design to move first.

## 2026-09-15 — Wave 4 closed; 59 components

Verified independently: `tsc` clean, six lint gates clean, leakage clean, 2961
pass / 24 skip / 0 fail, 486 storybook tests in real Chromium, brand sweep
empty, `agentorbit-placement` 8 pass, eight DC parity comparisons.

Thirteen components: the four agent views, six pieces of chrome, `ScreenBody`,
and D22's two desktop components. `PhoneFrame` shipped as story furniture, not
as a component (D16), so the kit exports 59 and the tarball contains no frame.

### D27 — the negative-margin hit target is exact; the pseudo-element one is not

Wave 3 found `inset: -9px` on a bordered element short by 1px per side, because
`inset` resolves against the containing block's PADDING box. The brief asked
whether the padding/negative-margin method carries the same error. **It does
not**, and the reason is structural rather than incidental: padding is not
measured against anything, it IS the box, so the expansion is exact whether or
not the element has a border.

The neighbour constraint still applies, and for `TabBar` it now has a measured
number. With `justify-content: space-around` the clear gap between two slots is
the bar's free space over the slot count, so for the five default slots it
reaches the required 28px at a bar width of **276px** — measured, not derived:
275px touches at -0.02px, 276px separates at +0.19px. **A five-slot tab bar below
276px steals its own clicks.** Comfortably under any phone the design targets,
but it moves with the slot count and the label lengths, and the floor is now
recorded in the component, in the README and in a story that reproduces the theft
at 240px.

**One deliberate departure from D20's gating rule.** `TabBar`'s padding is
ungated, unlike wave 1's `.bk-switch::before` and wave 3's `.bk-thumb::before`,
because it is ALSO the badge's containing block — `right: 0` resolves against the
padding box, so gating it would move the badge out of the corner the moment an
item lost its handler. Geometry that two things depend on is not gated on one of
them. The cost is that a static item in a mixed bar still carries an expanded box.

### D28 — `stageWidth` is a cap, not a width

`#storybook-root` shrink-wraps under the preview's `layout: "centered"`, and the
stage is `width: 100%; max-width: <stageWidth>`. A component that does not force
a width therefore renders at its CONTENT width and the cap never binds — measured
at 212.23px for `LaneChart` in a 244.23px root, against the 360 its parameter
names.

**Were the earlier assertions wrong, then? No, and the reason is specific rather
than reassuring.** Waves 1-3's layout assertions go through `overflowing()`,
which compares `scrollWidth` to `clientWidth` and then each child's edges to its
parent's. Every one of those is RELATIVE — it asks whether content fits its own
box, whatever that box turned out to be — so a narrower box cannot corrupt it.
It can only make the test easier or harder to pass, never wrong. The assertions
that D28 would have invalidated are ones about an ABSOLUTE pixel number, and
waves 1-3 made none; wave 4 is the first to need any, which is why it is the
wave that found this.

The corollary is the rule: **any story that measures geometry must state its own
width in a wrapper**, which `TabBar`'s now do. At content width `TabBar`'s five
slots touch and their padding boxes overlap by 28px, which would have made every
number in `HitTargetIsExact` meaningless while still passing.

### `Composer` is net-new work, and it is finished

The design's own known-gaps list asks for the real input, so this is not a port
and should never be read as one. ⏎ sends, ⇧⏎ inserts a newline, the ring moved to
the field via `.bk-field:has(:focus-visible)`, and with no `onChange` the field
is genuinely `readOnly` rather than a div wearing `role="textbox"`. Height
follows a controlled value's newline count, capped at five rows, which keeps the
component a pure function of its props at the cost of not growing on soft wrap.

The parity harness cannot compare it on anything. That is the correct outcome for
a component that deliberately renders a different element.

### `ScreenBody` is the one addition, and it earns its place

`flex: 1; min-height: 0; overflow` is retyped by hand on every assembled screen
in the catalog. A flex item without `min-height: 0` is floored at its content
height, so the body grows instead of scrolling and the tab bar walks off the
bottom of the phone — a failure that reads as "the list is too long" rather than
as a missing declaration. Nine screens, nine chances to get it wrong.

### `AgentRunCard` takes `agent`, not `name`

The source's `data-props` declares `name` while its own `renderVals()` reads
`p.agent`. The half that renders wins, and the design's own prose agrees
("FileRow uses `label`, AgentRunCard uses `agent`"). `name` was only ever reserved
because `<dc-import name="…">` owns that attribute — a DC constraint React does
not have. The wave-0 inconsistency is closed.

### D29 — sharpens D26: demo world versus developer-facing default (maintainer)

Wave 4 replaced four fallbacks and then reverted one, and the ruling that came
back is worth more than the string. **D26 said "replace only actual
contamination"; D29 says what actual means**, and draws the line by AUDIENCE
rather than by coherence:

- **Stories and fixtures are the demo world.** They appear in screenshots,
  website copy and demo videos, so they must be Odyssey, coherent, and free of
  real brands and real people. No exceptions.
- **Runtime fallbacks are developer-facing defaults and parity anchors.** They
  are visible only to a consumer who renders a component with no props. They
  stay verbatim *unless they carry a real brand or a real person*, because
  divergence costs us the ability to parity-compare — and that has repeatedly
  paid, including twice in wave 4.

**So the test is not "is this in-world?" but "would shipping this string name
something REAL?"** A real airline does. A real city in a task description does
not.

Applied: `GraphView`, `CommandPalette` and `MessageBubble` replaced (a real
airline, a plausible real person, a real city used as a project). `AgentRunCard`
restored to the source's "Compare the three Lisbon venues against last year's
notes", which makes it consistent with the nine wave-3 fallbacks that mention a
Lisbon workshop and buys back its default parity — 9 nodes each against the DC
page, the only difference being the `margin: auto` container-width class.

This also retires the standing question wave 3 left open ("should D19 extend to
fallbacks?"). It should not, and now there is a rule rather than a case list.

### The third interaction class is one declaration

`.bk-row-fg`, an additive modifier adding `color: var(--hv-fg)` on hover — the
exact sibling of wave 2's `.bk-row-border`. `TabBar` takes it alone (a tab bar has
no row to shade), `SideRail` takes it with `.bk-row`'s background. Both are
`.bk-row` rather than `.bk-control` on the design's own discriminator: their
focus ring is at -2, drawn inside, because a nav item sits against a container
edge.

`.bk-row:hover`'s background gained a `, transparent` fallback so that a
component setting only `--hv-fg` does not get its background reset to initial by
a declaration invalid at computed-value time. Changes nothing for the fourteen
components that set `--hv-bg`.

### `LaneChart` is where tokenisation broke the source

It derives two fills by concatenating a hex alpha suffix onto the lane's own
colour (`c + '80'`, `c + '8c'`). `var(--bk-teal-ink)80` is not a colour, so the
two derived values became two real seven-tone ramps at 0.5 and 0.55.

A consequence worth keeping: the hatch is keyed off the legend's glyph STRING, so
`fixtures/runs.ts` spelling `glyph: "hatched"` would have drawn the solid swatch
— a legend saying "running" beside a chart saying "stopped". Exported as
`HATCH_GLYPH`, ported as found, asserted in a story.

### The preflight box-sizing exception is a pattern, not a series of one-offs

Fourth and fifth instances: `TabBar`'s badge (a fixed 15px box with 3px padding,
6px narrower under border-box, showing up as a 6px `left` because it is
positioned by `right: 0`) and `PhoneFrame`'s bezel, where border-box was eating
9px of the device's own screen and a "390x844" mock was really 372x826. The frame
sets `content-box` explicitly, because a bezel is outside the screen.

### `browser-window.jsx` was not ported

It is Claude Design's own starter scaffold — Chrome's chrome in Chrome's greys,
marked "raw elements/hex/px by design" — rather than Brain Kit design. Nothing in
wave 4 or wave 5 needs a browser mock: `SideRail`'s two-pane stories present a
desktop layout honestly, without pretending to be a browser.

## 2026-09-15 — D30: `data-props` defaults are editor seeds, not component defaults

All 58 sources swept. **254 props carry a non-empty `data-props` default; 12
diverge** between DC's propless render and ours. The rest are identical
(reachable `??`/`||` fallbacks, booleans read as `!== false`, or equality checks
where the default *is* the un-passed branch), or already covered by wave 1's
"genuinely optional props stay bare".

**Decision: keep the port as it is. Do not resolve `data-props` defaults into
React defaults.**

The deciding argument is what those twelve defaults actually *are*. Nine of them
are booleans and enums whose default makes the component render its **emphasised**
state: `ChoiceOption.selected`, `ListRow.selected`, `FileRow.active`,
`StatusDot.pulse`, `ActionCard.footPulse`, `Callout.italic`,
`ScreenHeader.metaTone='teal'`, `ActionCard.rightMetaTone='red'`,
`TrendChart.deltaTone='red'`.

Reproducing DC would make a propless `ChoiceOption` render *selected* and a
propless `TrendChart` render *red*. The sharpest case is `TrendChart.deltaTone`:
`'red'` as a React default would make **every un-toned delta read as bad news**.

So the `data-props` defaults are optimised for a catalog preview — "show me what
this looks like" — not for "what should this be when unspecified". A catalog
wants the interesting state; a component library wants the neutral one. They are
different questions and the design only ever answered the first.

Cost of this choice: our Storybook and the DC catalog disagree on propless
renders, and parity comparisons pass explicit props. Waves 3 and 4 already paid
that without difficulty — six of eight wave-4 comparisons needed no props at all.

**This is an existing rule applied consistently, not a new one.** `Meter.variant`
and `StatusDot.pulse` are in the twelve and have the same shape, so wave 1's
ruling already covered them. (`Button.size` is not: its `p.size || 'md'` is
reachable, so the port is right by any reading.)

### The one genuine defect, which goes back to the designer

`AgentRunCard.progress` is the only case where a `??` **exists and is
unreachable**: `Number(p.progress ?? 72)` sits beside
`showProgress: p.progress !== undefined`. Every other divergence is honestly
signalled by having no fallback at all; this one *looks* like a kept fallback
while behaving like the rest. That is a readability trap in the source — dead
code that reads as live — and it is why this whole question looked like a new
policy rather than an old one.

Action: keep the behaviour, delete the dead operand, and comment why, so nobody
later "fixes" the gate to use a fallback that was never reachable. Render parity
is unaffected — it is source text, not output. Add it to
`design-feedback.md` as a source defect.

## 2026-09-15 — D17 is closed: the accessibility gate is real

`parameters.a11y.test` is `'error'`. D17's condition for closing itself was not
that the flip be made but that it be **shown to matter first**, and it was:

| Run, whole suite | Result |
|---|---|
| seeded `<img>` with no `alt` in `Callout`, gate at `'todo'` | 503 passed, 0 failed, **exit 0** |
| same seed, gate at `'error'` | 497 passed, **6 failed, exit 1** |
| seed removed, gate at `'error'` | 503 passed, 0 failed, exit 0 |

The first row is the point. A textbook defect in a real component, rendering in
six stories, passed CI completely green — so every accessibility claim waves 1-4
could have made was unverified in exactly that way, and "it passes" was never
evidence.

**The general rule this sets, and it is not about a11y:** a gate that has never
been observed failing is a configuration, not a gate. The cost of finding out is
one seeded defect and one extra run.

A near-miss is worth recording alongside it. The first seed — removing `Toggle`'s
`aria-label` — failed at `'todo'` as well, through this wave's own
`findByRole(…, { name })` assertions rather than through axe. It would have
"proved" the gate using a mechanism that is not the gate. **A seed only
demonstrates a gate if nothing else in the suite can see it.**

### What the gate now enforces

Every axe rule, on every story, in real Chromium, failing the run. The single
sanctioned exception is `knownContrastGap(reason)` in `stories/_stage.tsx`, which
disables **one rule on one story** and requires the call site to state why. Nine
call sites use it — two of them at a `meta`, because the same defect is in every
story of that file — for four causes, all of them palette decisions. Every other
axe rule still runs on those stories, and `color-contrast` still runs on the
rest.

### What remains a documented gap

Ten entries, `design-feedback.md` §§4-13. The four contrast ones (§§4-7)
each carry a computed assertion in `tests/contrast.test.ts`, so they fail when a
token moves; §11's cost is asserted as a literal tab-order list. The four that
matter most:

- **§4-5, the ink ramp.** The design's floor claim is exact — `#8a8691` is 5.09
  on surface — and it holds on **no other ground the kit uses**. Over `raised`
  plus any one of 81 tints it fails all 81; under `opacity: .7` it is 3.08. A
  floor measured on the one surface that never carries a tint is not a floor.
  `tests/contrast.test.ts` recomputes every number from the tokens, reproducing
  axe's own composited hex values exactly.
- **§7.** A solid button's effect chip is under 4.5 on every tone **and axe never
  saw it**, because no story renders that combination. "axe is green" and "the
  palette is sound" are different claims; that is where they part.
- **§11, the tab order.** Every `tab` and `radio` in the kit is its own tab stop,
  where the ARIA pattern wants a roving tabindex — ten tab presses to get past
  the navigation on a screen carrying both nav components, asserted as a list of
  names in `stories/rules/Keyboard.stories.tsx`. Not changed here because the
  half-right version makes a group with nothing selected **completely
  unreachable**, and each of the four components needs its own answer to "which
  item is the tab stop when the obvious one does not exist".
- **§10.** Three bindings in the design's own role-and-keys table have nowhere to
  land, because each component has one handler and they need three. Left alone
  deliberately: WCAG 2.1 SC 2.1.4 makes an unmodified single-character shortcut a
  conformance question, and the answer is the design's to give.

### Two divergences from the source, both recorded

- **`FileRow`: every operable row is a `treeitem`.** The source picks per row —
  `treeitem` for a folder, `option` for a file — and **no container satisfies
  both**, so axe failed it from both ends at once and no call site could have
  fixed it. The design's own role table says `button` / `treeitem` and never
  mentions `option`, so this moves the port towards the spec. §9.
- **`Toggle` gained `label` / `labelledBy`.** Net-new: the design draws a switch
  as pure geometry, and a switch is the one control with no visual words to fall
  back on. §12.

### Three findings that generalise past this wave

- **Follow the handler to the element, not to the interface.** Ten components
  declare a handler prop; only **five** put it on a bare `<div>`/`<span>`. The
  other five route it into a `Button` and inherited every state when `Button` got
  them. D24-superseded predicted nine from the prop tables and was four out.
- **A rule with one implementation should have one override.** Reduced motion is
  a single media query redefining the single `breathe` keyframe, because the six
  call sites write `animation` on their own **inline** style and a stylesheet
  cannot reach an inline style without `!important`. Redefining the keyframe
  reaches every call site, present and future, from the one place the motion is
  described. Two consequences that are easy to get backwards and are now
  asserted: two `@keyframes` of one name resolve by **source order**, so the
  override must come second or it silently does nothing; and the single stop must
  be the **rest** state, since a dot left at `opacity: .6` reads as disabled —
  meaning lost rather than motion removed.
- **Check a rule against the artefact that ships.** `ReducedMotion` walks
  `document.styleSheets` in the browser rather than reading `theme.css`, because
  a rule that is correct in source and dropped by the build is invisible to a
  grep. Same class as wave 1's `@theme static`.

### `.bk-control:hover` and `.bk-row:hover` are no longer symmetrical

Wave 4 gave `.bk-row:hover`'s background a `, transparent` fallback so a
component setting only `--hv-fg` would not have its background reset. `.bk-control
:hover` has no such fallback on `border-color`, so an unset `--hv-bd` there is
invalid at computed-value time and resets the border to `currentColor`.

**Consequence, now load-bearing:** a toned `.bk-control` cannot simply decline to
move its border on hover — it has to restate it. `Placeholder`'s retry sets
`--hv-bd` to its own rest border for exactly this reason, and the reason is
written next to it, because the code looks like a redundant no-op and is not.

## 2026-09-16 — D31: there is no backwards-compatibility burden (maintainer)

Asked before starting wave 6, because `AGENTS.md` attaches "a major-version
discussion" to any change to the compatibility contract and that is not a call
to make alone. The answer removes the question rather than answering it:

> "Do not be bothered with backwards compatibility — I personally am the only
> user right now, the OSS portion has never been made public so far. The only
> thing that is important is that my personal implementation I run on
> [the maintainer's host] (using the brain-ui implementation) does not break
> between deployments and remains usable to me on my phone via the PWA (a
> forced refresh or reinstallation is okay)."

**What this changes.** The `CONTRACT:` commit prefix and the
`docs/integration-contract.md` update still stand — they are how the contract
stays *documented*, which is worth having whether or not anyone is depending on
it. What does not stand is the veto: a contract change no longer needs a
major-version discussion, no longer needs a deprecation window, and no longer
needs a shim. **D15's "the shim is removed at 1.0" is now free to happen
whenever it is convenient**, and step 2's S10 stops being a separate step.

**What it does not change.** There is exactly one real deployment and it must
keep working across a deploy. So the bar is not "no breaking changes", it is:

1. **Server and client ship together.** A protocol change is fine; a protocol
   change that leaves a running server talking to a stale client is not. Both
   halves land in one release.
2. **A stale PWA must fail LOUDLY, not subtly.** A forced refresh or a
   reinstall is acceptable; a phone that renders a half-broken screen because
   its cached bundle predates the change is not. If a change can strand a
   cached client, it needs a version check that says so.
3. **Nothing about lockstep versioning changes.** All `@schlessera/brain-*`
   packages still version together, and the release guards in
   `tests/release-manifest.test.ts` still apply — those exist to stop a package
   shipping pinned to a version nobody published, which is a different hazard
   entirely and is not about compatibility.

This also settles the sequencing question wave 6 was blocked on. `PLAN.md` put
D3's tool contracts in step 1 and `DECISIONS.md` sequenced them as S9, after the
`ui-react` rewire, because `bind(contract, Component)` lives in `ui-react` and
S1 fixes that package's renderer registry first. With no compatibility burden
the ordering is a matter of engineering convenience rather than of exposure, so
**wave 6 may fix the registry as part of itself** instead of waiting for S1.


## 2026-09-16 — four decisions wave 6 made while building the contract layer

**1. A contract with no payload is a first-class shape, and `query_activity` is
one.** The obvious design gives every tool a payload schema. `query_activity`
must not have one: its result is free text from past runs, wrapped in a
nonce-suffixed delimiter precisely so the model reads it as data rather than as
instructions. A payload schema is an invitation to hand that text to a
component, which is a separate decision with its own threat model. So
`ToolContract` and `ToolComponentContract` are two types, `bind()` accepts only
the second, and the refusal is structural rather than a comment.

**2. Bound renderers register GLOBALLY, and the backend-scoped entry had to
go.** The registry resolves backend-scoped exact names before global ones. The
Claude pack listed `mcp__brain-ui__get_current_location`, so a global
contract-bound renderer for the same tool would never have been reached — it
would have looked like `bind()` was broken. The rule that falls out: a tool that
belongs to the CHAT UI is registered under every spelling of its name and scoped
to no backend, and only a tool that genuinely belongs to one backend is scoped.

**3. The payload convention is now followed, not just declared.** pi's
`request_image_mask` reported a sentence while ask_user and
get_current_location serialised payloads, which is the "convention we are
establishing, not following" the plan flagged. Establishing it meant changing
what the model sees for that tool and moving a characterization fixture that
exists to pin pre-refactor behaviour. That is allowed under D31, and the drift
test now states in words that this one result is expected to move — a
characterization test that is silently re-baselined stops being one.

**4. Idempotence belongs to a registry, never to the module that fills it.**
Both `registerBuiltinRenderers` and `registerAsrClients` guarded themselves with
a module-level `registered` boolean that the matching `reset*` could not clear,
so the first reset anywhere permanently un-registered them. The renderer
registry dedupes by pack identity and the ASR registry is keyed by provider id,
so both latches bought nothing and cost the ability to reset. The general
form: **a latch outside the thing being reset is a bug waiting for a reset to
exist.**

## 2026-09-18 — D32: the light theme is `light-dark()` per token, switched by `color-scheme` under `[data-theme]`

The second design drop shipped the paper palette in full (`design/light.md`),
so the light-theme wave D21 deferred is done. The contract says "route the tone
maps through custom properties on a `[data-theme]` root"; the kit already
routed every colour through `--bk-*`, so the question was only how the second
set of values is switched. Researched against MDN, web.dev and the Storybook
and Tailwind v4 docs before choosing.

**The mechanism.** Every token is one declaration, `--bk-x: light-dark(<paper>,
<dark>)`, and `color-scheme` picks the half: `:root { color-scheme: dark }`
keeps the kit dark for a consumer who does nothing, and `[data-theme="light"]`
/ `"dark"` / `"system"` set `light` / `dark` / `light dark` — the design's
three-way toggle, on `<html>` for an app or on any element for a subtree.
`system` is the browser's own `prefers-color-scheme`, with no script and no
flash. Baseline since May 2024; in an older browser the declaration is invalid
at computed-value time and the element renders no colour, which is the loud
failure the kit already chose for a missing stylesheet.

**Why not a second `[data-theme="light"]` block of 300 values**, which is what
the stub in `theme.css` had sketched: (1) one declaration per token keeps each
light value beside its dark one and the comment that explains it, and cannot
drift from it by omission; (2) the UA's own chrome — scrollbars, form
controls, the composer's textarea — follows `color-scheme` for free, and a
block does not do that; (3) a light subtree inside a dark page needs no
selector work, because the property inherits and `light-dark()` reads it
where the token is USED — the paper `PhoneFrame` story proves the nesting;
(4) system preference costs nothing, where a block needs either a duplicated
`@media` copy or a script. **Why keep `data-theme` at all:** it is the attribute
the design's contract names, it is what `@storybook/addon-themes` sets, and it
is what an app's persisted choice writes — `color-scheme` stays the
implementation underneath it.

**Where the values come from.** The design draws about fifty light values
(§L3/§L4) and states the base palette and accent pairs (§L5); it says nothing
about the other ~260 alpha tokens. Those are derived by one rule each in
`tools/theme/derive-light.ts` — tints keep their hue role and step +0.07 in the
fill hue (capped at 0.16), borders step +0.05 in the ink hue, white veils
invert to ink — and the generator rewrites `theme.css` and `LIGHT_TOKENS`
in place. `tests/light-theme.test.ts` pins both to the generator, so a light
value can only change as a rule or as an entry in the `SPECIFIED` table, and
the line between "the design said" and "we chose" stays in one file. The
design's own rule against deriving one theme from the other is about hue and
lightness (no `invert()`, no programmatic lightening); the derivation here
touches only alpha, and never a hex the design gave.

**Proof.** The a11y gate runs every story on paper: a second Vitest project
pins the `theme` global to `light` (`initialGlobals`, D9's matrix made real),
and `tests/contrast.test.ts` measures the light ramp and every accent ink on
its own tinted ground over the canvas. The first run of that gate found the
first light palette failing on 141 stories (design-feedback §19); the design
revised five inks the same day and the gate is green with one recorded
exception (§20). What it does not prove: pixels. No light visual baselines
exist yet, and the dark ones that changed need a container run.

## 2026-09-18 — D33: `neutral` is the grey accent and nothing else; `on-fill` is what sits on a fill

The drop tightened the tone vocabulary to ten members (`design/catalog.md`
§1.1b) after design-feedback §4: `ink`, `dim` and `edge` are named, `neutral`
means `#8a8691` in every component, every lookup falls back to `dim`, and the
dead `muted` entries are gone. The kit follows: `ValueTone = Tone | "ink" |
"dim"` for values inside an answer (`StatTiles`, `ComparisonTable`, `Receipt`
rows, `ContactCard` facts — which also settles §2), an untoned value takes the
component's stated default (ink, ink, dim, dim), and `ScheduleList` names
`edge` for its untoned rail. Wave 3's "ported as found" notes for these five
components are superseded, and the fixtures were audited for a `neutral` that
meant "plain" (one, the digest's `days out` tile, now untoned).

The same drop settled what sits on a solid accent: near-black ink in both
themes, the README's `--on-fill`, "including count badges". `--bk-on-fill`
(`#0c0e12` / `#231f1a`) replaces every foreground use of `color.canvas`, and
`--bk-on-ink-solid` (`#0c0e12` / `#f8f5ef`) covers the two discs the light
catalog fills with an accent's INK rather than its fill — a selected option's
mark and a done step's bubble — where the light glyph has to be surface, not
ink. The distinction is the light theme's, not the dark's, which is why it
needed two names.

## 2026-09-18 — D34: hit targets are specified as reach past the paint, and the paint carries no border

The drop answered design-feedback §1 with a rule rather than two numbers, and
stated it three times (README, catalog §11, desktop D3): a small control's
target is its transparent `::before` at negative inset, **specified as the
reach past the paint**; a hairline on such an element is `box-shadow: inset 0
0 0 1px`, an underline is `text-decoration`, never a border, because an
absolutely positioned pseudo-element is offset from the padding box and a
border eats a pixel of reach per side; and **expansion is constrained per
axis** — per side, at most half the distance to the nearest interactive
neighbour on that axis. `FeedbackRow` is 46×44 from a 30×26 thumb
(`inset:-9px -8px`, 8 horizontally against an 18px gap), `InlineToast`'s undo
45×45.65 (`inset:-16px -10px`), `Toggle` 44×44 as before. The kit's stories
measure all three with `elementFromPoint` at the edges, and now also assert
that the border is zero — so a border creeping back fails a test rather than
shaving two pixels silently, which is exactly how it shipped under spec for
three waves. The consequence for the hover mechanism: a shadow is not a
border, so `.bk-thumb:hover` and `.bk-undo:hover` carry their own rule in
`theme.css` beside the shared `.bk-control:hover`.

## 2026-09-18 — D35: the dark floor is `#9a96a1`, and the paper palette is stated three times per hue

The fourth drop answered the ledger's palette questions with numbers rather
than exceptions. **Dark:** machine-meta ink moves from `#8a8691` to `#9a96a1`
— "6.26 on surface, 5.83 on raised, 4.80 on the worst documented tint" — and
`neutral` moves with it, because it is the same colour. `opacity` on a row is
gone as a de-emphasis (a superseded queue item reads as superseded from its
state word and its still dot). The well on a solid button lightens
(`rgba(255,255,255,.28)`) in both themes and its subtitle is opaque `on-fill`
at weight 500. **Paper:** every accent carries ink, fill and dot; teal, purple
and red came down once more for two stacked tints of one hue (`#15594c`,
`#5d4489`, `#9c2a24`); all seven dots are stated and judged against the 3:1
non-text bar. The kit takes all of it through the two places it already had —
`tokens.ts` for dark, `derive-light.ts`'s `SPECIFIED` table for paper — and
the effect is measured rather than described: `tests/contrast.test.ts` now
asserts §4, §5, §7 and §20 as resolved (ink-mute clears every tint over both
grounds; the effect chip clears 9:1 on every fill), and the light story
project runs with no contrast exception. The cost is every dark visual
baseline, which is what a floor move should cost.

## 2026-09-18 — D36: single-key shortcuts are focus-scoped; a resolved decision hands focus to the next card or the empty heading

The design's answer to design-feedback §10, verbatim in its README and D3:
`a` / `d` / `s` act only while the ActionCard they belong to holds focus, and
are printed on that card's own buttons; `j` / `k` only inside the focused
list, printed in its footer; anything global takes a modifier (⌘K, ⌘1–⌘5);
Settings carries an off switch for single-key shortcuts (WCAG 2.1.4's third
escape hatch). Focus after a decision goes to the next card, and when the
resolved card was the last, to the `EmptyState` heading, "focusable for
exactly this reason". These are app rules and land with the desktop
migration (S7+); the kit's share is small and done: `EmptyState`'s title is a
`role="heading"` at `tabIndex={-1}` with a `focusTitle` prop, `Home` / `End`
reach the edges of every roving group (`focusEdge`, beside `focusSibling`),
and the printed keys are ordinary label text. The kit does not bind `a`, `d`,
`s`, `j` or `k` itself: which card is "focused" for the purpose of a letter
key is the list's knowledge, not the card's.

### D36 addendum — printed keys follow the pointer, so a keyboard-only tablet goes without them (maintainer, 2026-09-22)

"Every shortcut is printed where it applies" met a tablet in landscape: past
`laptop:` it read the rail's `⌘1`–`⌘5` and a footer of letters it had no key
to press. #86 and #100 answered that by printing those keys — the rail's
`⌘1`–`⌘5`, the approval cards' `a` / `d`, the search and add panels' hint
lines, and the Actions pane's `j` / `k` / `d` — only while
`(any-pointer: fine)` matches (`useFinePointer()`,
`packages/ui-react/src/hooks/use-fine-pointer.ts:13-15`). The palette's `⌘K`
on the rail was left out of that and still prints everywhere. The
**bindings** do not follow the pointer: every key stays registered in every
state, and the Settings switch still decides whether single letters bind at
all.

That query is a proxy for "a key can be pressed", and one configuration falls
through it: **a tablet with a keyboard but no trackpad** (a keyboard folio
without a trackpad, or any Bluetooth keyboard paired to a touch-only tablet).
It reads coarse, so none of those keys print, while every binding still fires. A
keyboard that carries a trackpad reads fine and is unaffected.

The platform offers nothing better. Media Queries Level 4 defines `pointer`,
`hover`, `any-pointer` and `any-hover`, and says they "only relate to the
characteristics, or the complete absence, of pointing devices, and can not be
used to detect the presence of non-pointing device input mechanisms such as
keyboards". **There is no keyboard-presence media query.**

**Ruling: do nothing (#106).** That tablet keeps working bindings and goes
without the pointer-gated hints. The alternatives were weighed and rejected:

- **Reveal the keys on the first keydown** re-breaks #86: a soft keyboard
  fires `keydown` with real `key` values, so a touch-only tablet typing a
  search query would summon the `⌘1`–`⌘5` row #86 removed.
- **Reveal on a keydown a soft keyboard does not send** (a `meta` / `ctrl` /
  `alt` chord, `Tab`, `Escape`, `F1`–`F12`) asks the reader to press a key
  before learning which keys exist — `⌘1` is one of the things the hint was
  meant to teach — and costs a mid-session reflow plus a module-level flag in
  a single-process test file.
- **A "show keyboard shortcuts: auto / always / never" preference** is a
  settings surface for a rare case, and a second switch beside
  single-key shortcuts that governs something different.

What would reopen this is a signal that says a hardware keyboard is present,
not a better guess from the pointer.


## 2026-09-19 — D37: five destinations everywhere, and the desktop is drawn

The fifth drop answered the eleven questions the maintainer forwarded
(`design-feedback.md`, "The fifth drop"; the pane spec is in
`design/desktop.md`). The decisions that bind the app:

1. **The destinations are Chat · Actions · Files · Graph · Settings**, ⌘1–⌘5,
   on the rail and the phone bar alike. Activity is the `done` lens of
   Actions (`needs you · running · done`), not a place; the Activity page
   becomes the Actions page with the filter, inbox pinned above the run log.
   Graph is a destination. The phone bar folds Settings into More, which is
   the kit `BottomSheet` holding Settings and the acts. New chat is the Chat
   header's primary action and a palette row, never a slot. This supersedes
   the S7 rail mapping (Chat · Activity · Files · Graph · Settings) and the
   phone bar's New chat slot.

   > **2026-10-06 — Superseded in part by [D52 §1](#1-destinations-acts-and-the-palette-amends-d37-1).**
   > The destinations are now Chat · Sessions · Actions · Files · Settings
   > on the rail (⌘1–⌘5) and Chat · Sessions · Actions · Files · More on the
   > phone. Graph is reached through More and the palette's Jump to, with no
   > key. New chat is the Chat overlay disc below 1280, the Sessions pane's
   > `New conversation` at ≥ 1280, and a palette row; still never a slot.
   > Activity as the `done` lens of Actions and More as a `BottomSheet`
   > still bind.
2. **A four-pane screen needs 1440.** 1280 gets rail + list + detail. The
   ladder's 480/900/1280 defaults stand; above 480 the rail may be collapsed
   by the user and it sticks.
3. **The palette groups by what ⏎ does** (Jump to · Ask · Run), spending is
   an effect (a gold cost chip), and an unservable command is disabled with
   its reason rather than omitted. The query is a real input.
4. **The composer is kit-owned.** The app's `ComposerView` retires; the app
   keeps only the attach sheet, the provider list and the handlers.
5. **No snooze on a blocking approval**; "Always allow" has no key.
6. **Focus after the last decision in a list goes to the `EmptyState` heading
   that replaces the section, with the `InlineToast` receipt above it**; the
   composer in a transcript. The page heading is a fallback only where no
   empty state can exist.
7. **Location:** the kit `MapView` owns the span rule, the accuracy ring,
   the note and the 420px cap; the app passes the payload through.
8. **One closing row per answer:** chips while live, `FeedbackRow` later.

Not followed: ⌘N for New chat (the browser owns it; no key is printed), and
undo on the inbox receipt until the activity API can un-acknowledge.

## 2026-09-19 — D38: the sixth drop's rulings

The design answered the twelve questions the fifth drop left open
(`design-feedback.md`, "The sixth drop"). The decisions that bind the kit and
the app:

1. **A question is an exchange.** `AskUserCard` has three states — pending,
   answered, typed — and all three stay in the transcript at full contrast.
   A composer send while a question is pending IS the answer: the app binds
   it to the question and does not send it as a message. Nothing rolls up.
2. **A mask is a receipt.** Source thumb, the region in teal, a `Receipt`
   of the facts, stacked; a dismissed mask is stated as a fact in red mono,
   never silently "whole image".
3. **The Files rail never collapses**; blocks are absent without data.
   Stale is built from `mtime` and a threshold; Untrusted is drawn disabled
   with its reason until provenance exists. Both are features.
4. **No receipt without undo.** Dismissal is silent until un-acknowledge
   exists. Approval decisions keep their receipt: the effect is out of
   sight, which is the ruling's own test.
5. **New chat has no key**; unknown cost says `spends`, no chip when a
   command cannot spend.
6. **The graph caption names the active rule, and entity is a fourth mode.**
7. **`← →` fold on tree rows, bound and printed together.**
8. **The closing row flips on the next user message.**
9. **Map cards are bounded (≤420 wide, 110–260 tall) and the fetch
   envelope is 1.5× wide by 1.0× tall.**
10. **Truncation is allowed only on rows that OPEN the record**, carried as
    `title`; a row that IS the record wraps.
11. **The neutral fill and the alpha derivation rule are the design's.**
12. **Three more screens after the acceptance four:** Actions triage, File
    viewer, First run.

## 2026-09-19 — D39: the app draws no colour of its own — `@theme inline` over `--bk-*`, ink and fill named apart

Asked to make sure the main screens are tested in light mode, the first thing
checked was the app shell itself, in a real browser at 1440 with
`data-theme="light"` set: the kit's cards turned to paper and the page around
them stayed `#0c0e12`. The cause was `packages/ui-react/src/theme.css`: its
`@theme` block held literal dark hex for `--color-background`,
`--color-surface`, `--color-foreground` and every other utility colour, so
`bg-background` and `text-foreground` — 150-odd uses — were the one place the
`light-dark()` switch (D32) could not reach. Two prose blocks
(`.brain-prose`, `.whatsup-briefing`) and the filament carried the same hex.
Four component files used Tailwind's own palette (`text-amber-100`,
`bg-amber-950/90`, `text-emerald-200/90`): light text for a dark ground, which
vanishes on paper.

**The decision.** The app declares no colour. Every `--color-*` utility is
`var(--bk-*)`, in a `@theme inline` block so the utility carries the token
itself and it resolves where it is used, not on `:root` — the same reason the
kit's `PhoneFrame theme="paper"` nests. The prose blocks and the filament use
the tokens by name (`--bk-filament-edge` / `-core` are the design's own two
stops), and the four alpha tints in the prose are `color-mix()` of the ink
hue, which is the kit's own rule for a border or a decoration on a tinted
ground; there is no paper value typed anywhere in the app, so
`tools/theme/derive-light.ts` stays the only place one lives.

**Ink and fill are two names.** The kit keeps them apart — `--bk-color-amber`
is `light-dark(#7f4c08, #e09f3e)`, the ink; `--bk-amber-fill` is `#e09f3e` in
both themes, the fill — and one Tailwind name cannot serve both: with
`--color-primary` as the ink, `bg-primary` on a button is dark brown on paper.
So `primary`, `accent` and `destructive` are the inks (`text-`, `border-`,
`ring-`, `accent-`) and `primary-fill`, `accent-fill`, `destructive-fill` are
the fills (`bg-`, solid or with an alpha), with `--bk-on-fill` as
`primary-foreground` / `accent-foreground`. Thirty-nine `bg-` sites renamed.
The surfaces map onto the kit's four (canvas, surface, raised, line/edge);
`surface-overlay`, which was one step above raised in the dark set, is
`raised` now — the kit has no fifth surface, and the app should not invent
one.

**Proof, and its limit.** `packages/ui-react/tests/theme-neutral.test.ts` is
the gate: no hex or rgb literal in `theme.css`; every `--color-*` is a kit
token or a `color-mix` of one and none is declared in the plain `@theme`
block; no Tailwind palette class anywhere in `src/`; solid black or white
only in the two files whose ground is not the theme's (the mask editor's
controls on a photograph, the HTML viewer's iframe); a hex in source only in
the six files that draw outside the DOM, each with its reason, and the
allowlist itself checked against the tree so it cannot go stale. That is
static. The runtime proof was the browser sweep — computed background,
border and text colour of every rendered element on Chat, Actions, Files,
Graph and Settings, in both themes, at 1440 — which is not a test because the
app has no browser harness; the kit's light visual baselines and the
`storybook-light` project cover the kit, and the shell's light rendering
rests on this gate plus the sweep recorded in the handoff.

**What stays dark, on purpose.** The sigma canvas palettes and the mermaid
theme variables are literal hex validated as sets against the dark canvas
(CVD order, lightness band). On paper the graph draws on `--bk-color-canvas`
and its labels take the ink, but the node colours are the dark set — legible,
not validated. A paper set is a design question, not a derivation
(design-feedback §14).

**The review's three findings, all real.** Codex (gpt-5.6-sol) read the
diff and found what the sweep cannot: contrast. A six-pixel status dot in
`bg-*-fill` is 1.9–2.5:1 on paper, under the 3:1 a non-text cue needs — the
kit's third weight, `--bk-*-mark`, exists for exactly that, so the app has
`primary-mark` / `accent-mark` / `destructive-mark` and its five dots use
them. The mask editor's error line sat in `text-destructive` on its
`bg-black/80` overlay, a dark red on black on paper — it is
`text-destructive-fill` now, the fill being the same light red in both
themes. And `text-primary/80` on the share block's format chip over a
`bg-primary-fill/15` tint fell to 3.5–4:1; it is the full ink. The lesson for
the gate: a class regex proves the theme reaches an element, not that the
element reads once it does — contrast on paper still needs eyes or numbers.


## 2026-09-19 — D40: the seventh drop's rulings — canvas palettes are tokens, the diff and the checkbox are the kit's

Ten questions, ten rulings (design-feedback "The seventh drop", §14–§23).
Binding:

1. **The canvas palettes are kit tokens** with a paper half from §L6:
   `--bk-canvas-slot-1…8`, `--bk-canvas-ramp-1…5`, `--bk-canvas-root`,
   `--bk-canvas-other`, `--bk-canvas-lens-*`, `--bk-diagram-*`. Slot order is
   frozen across themes. The app resolves a `light-dark()` token to the half
   matching the document's `color-scheme` before handing it to sigma or
   mermaid — canvas `fillStyle` cannot read the function — and re-resolves
   when the theme changes. Labels take the ink, never the node's colour.
2. **No fifth surface.** `surface-overlay` stays `raised` (D39 confirmed).
3. **Grounds take the fill hue, lines take the ink hue** — the general rule
   for any derived tint, prose included.
4. **A bare mark takes the mark value at every size.** Fill only under
   near-black content or behind a ≥3:1 border.
5. **`DiffBlock` has a `tinted` mode**; the app's diff view renders through
   it and its word-level highlight is gone (no design equivalent).
6. **`ChoiceOption.multiple`** (checkbox role, square mark) and
   **`AskUserCard.multi`** with `answers[]`; the app's own checkboxes are
   gone.
7. **`AskUserCard` has a fourth state, `dismissed`** (gold, lapsed row, "Ask
   again" behind `onAskAgain`). The app reopens the card locally; a submit
   from a reopened card is a normal composer message quoting the question,
   since the server's request is already resolved.
8. **State the absence**: the mask receipt reads "region not recorded"; the
   mask is drawn over the thumb when its bytes exist, else the thumb says
   the mask was not rendered.
9. **The token swap is the spec** for desktop screens on paper; the
   maintainer's screenshots are the record.
10. **`ApprovalCard`: Allow `flex: 1 1 auto`, Deny content-sized with a
    96×44 floor; the target wraps.** The kit's earlier 50/50 divergence is
    withdrawn.

**The review's four findings, all real.** Codex (gpt-5.6-sol) on the three
commits: multi-select closed the Other field when a neighbour was picked
(fixed: it stays open while Other is on); a reopened question stayed pending
after its message went out (fixed: it closes again); the mask receipt
trusted a byte count as proof the browser had the PNG (fixed: fill and
label only after `load`, "mask not rendered" on `error`); and the kit's
`diffRows` stripped one character from a context line where a unified diff
carries two, so context rows sat a cell to the right (fixed; a recorded
divergence from the design's source, which has the same off-by-one).

## 2026-09-21 — D41: the answer blocks reach the model through one tool, `show_block`

**Question.** The kit holds the design's §08 and §10 answer blocks —
`ComparisonTable`, `StatTiles`, `TrendChart`, `DataTable`, `BarList`,
`Receipt`, `StepList`, `TimelineList`, `ScheduleList`, `QuoteCard`,
`ContactCard` and more — and the app renders none of them from an answer.
The model can reach markdown (tables, fences, wikilinks, the share block) and
the four bridge tools; nothing tells it a comparison table exists, and it has
no way to emit one. Asked on 2026-09-21: do the agent's instructions, skills
and tools cover the inline components? They do not. This is the wave that
closes it, on the seam D3 already settled.

**Decision.**

1. **One tool, a union of blocks.** A single contract, `show_block`, whose
   input is a zod discriminated union on `block`: `comparison`, `stats`,
   `trend`, `table`, `bars`, `receipt`, `steps`, `timeline`, `schedule`,
   `quote`, `contact`. Its payload is the same schema: the handler validates
   and echoes, and the client renders the echoed payload through `bind()`.
   One tool keeps the prompt to one paragraph and the contract count at
   five; per-block tools would ride a dozen paragraphs on every turn for
   guidance that belongs in the tool description, which the model reads
   once per session.
2. **Data only, no handlers.** A block variant carries only what
   serialises. `ContactCard` ships its facts and no actions;
   `LinkPreviewCard` (needs a URL the kit prop has no home for),
   `Disclosure` (a body the model would author as markdown), `FeedbackRow`
   (a rating that must be recorded somewhere) and `SuggestionChips`
   (follow-ups that send through the composer) each need a handler or a
   second decision and wait for one. `MapView` already arrives through
   `get_current_location`; agent-authored pins are a later variant.
   `CodeBlock` is the markdown fence. `SearchResultCard`, `TraceSteps`,
   `DigestCard`, `StreamingAnswer` are the surface's own evidence and never
   the model's to draw.
3. **A block is part of the answer, not a step in the trace.** In the
   transcript it renders inline at the tool call's chronological position,
   the way `ask_user` does, not inside the collapsible tool timeline. In the
   Actions trace it stays an ordinary tool step, because it was one; the
   recorder does not change.
4. **The schema mirrors the kit's props and drift is a `tsc` error.** The
   block renderer is one switch typed by the contract's payload, handing
   each variant to its kit component. A kit prop the schema does not carry,
   or a schema field the kit does not accept, fails typecheck in both
   directions, as `bind()` promised in wave 6. Tone enums in the schema are
   the kit's `Tone` / `ValueTone` / `DeltaTone` sets and a test asserts the
   lists are equal.
5. **Side-effect free, so auto-allowed and bridge-free.** The handler needs
   no browser and no turn bridge; it lives in `ui-sdk/server` as
   `handleShowBlock` and both backends call it. It joins the auto-allow
   posture like the other bridge tools: an approval card for drawing a
   table would be the surface asking permission to answer.
6. **The brief says WHEN, the description says HOW.** The generated prompt
   line names the tool and the eleven blocks with one clause each on when a
   block beats prose: a comparison when the reader is choosing, tiles for
   three to four headline figures, a trend for one figure over time, a table
   for records, bars for shares of a whole, a receipt for what a tool did,
   steps for a procedure, a timeline for what happened when, a schedule for
   what is coming, a quote when the words themselves are the evidence, a
   contact when the answer is a person. The description carries the
   per-block shape rules the design set: at most three comparison columns
   under 700px, tiles in threes, values pre-formatted because the kit does
   no arithmetic, `recommended` on at most one column and only with a
   footnote that states the cost.
7. **It is a `CONTRACT:` commit.** A new tool name and payload in the
   chat-UI tool table of `docs/integration-contract.md`, in the same commit.

**Alternatives refused.**

- *Fenced blocks* (` ```brain-comparison ` with JSON inside): D3 refused
  this in 2026-09-15 and the reasons hold — no schema the model is handed,
  no description it reads, partial JSON while streaming, and the renderer
  becomes the validator.
- *Per-block tools*: eleven briefs on every turn, and eleven entries in
  every backend's allow list and renderer pack, to say what one union says.
- *A brain MCP tool in core*: the block is a fact about the surface, not
  the brain. Core has no chat.

**Not decided here.** The share-as-image path renders the last text group
only; a block inside the message is not in the PNG. That is the share
renderer's question and waits for it. Whether the model actually reaches for
the tool is measured, not assumed: wave 13 ends with three canned prompts on
each backend and the block rate recorded.

**Built 2026-09-21, two adjustments.** The union sits under a `block`
argument and discriminates on `kind`, not at the root on `block`: the Claude
SDK's `tool()` takes a raw object shape, so the argument root must be an
object. `ContactCard`'s `kind` prop travels as `contactKind`, because `kind`
is the discriminator. The tone-equality test is type-level and lives in
ui-react (`tests/block-contract.test-d.ts`), the one package that depends on
both the kit and the SDK — the kit exports types, not lists, so equality can
only be asserted where both are in scope.

## 2026-09-21 — D42: the surface classifies what the model typed, once per answer, through Jev

**Question.** Wave 13 measured the comparison prompt at 0 of 5: the model
reads "never write a markdown table; call `show_block`" back verbatim and
types the table anyway. Prompt text is not the lever. The surface can
still draw what it typed in the kit's shape, if something decides which
shape — a markdown table is a comparison, a data table, or neither; an
ordered list is a recipe, a checklist, or events in time; a run of
key-colon-value lines is a receipt, three stat tiles, or a person. Those
are judgments, not parses, and the user wants them made by Jev, TypeSafe
AI's System One model, which answers typed questions with calibrated
probabilities and generates no text.

**What Jev is, verified 2026-09-21.** `POST https://api.typesafe.ai/v1/systemone`,
model `jev-latest` (jev-1.13.0), bearer key from `TYPESAFE_API_KEY`;
`@typesafe-ai/sdk` 0.6.0 on npm, MIT, Node 20+. One request carries a
`state` (string, object or array, text only, 32k tokens) and a map of
named questions — `choice` over up to 255 options with per-option
probabilities and a confidence, `score` over 2–10 rubric levels, `noul`
as a 0–1 — all evaluated in parallel against the same state; "adding more
questions usually has little effect on response time". Latency 70–500 ms,
$0.042 per MTok in, output free. Documented rough edges: literal reading,
no arithmetic or counting, accuracy falls with irrelevant state, no
guarantee two phrasings agree. Their own "structure recovery" cookbook is
this design: one choice question per block with speculative companions,
in one call, with the code doing every extraction and every render.

**Decision.**

1. **One pass per answer, and only when warranted.** At turn end the
   server walks the markdown AST of the assistant message and collects
   CANDIDATES deterministically: GFM tables, ordered and task lists,
   blockquotes, key-colon-value runs, bullet lists whose items open with
   a time or a day, number series. Blocks already drawn by `show_block`
   are excluded. No candidates, no call — the common case. Candidates
   go in one Jev request as `{ items: [{ id, kind, text, headers?,
   rows? }] }`, never the whole answer, because irrelevant state costs
   accuracy; questions are per item with speculative companions read
   only when the primary answer makes them relevant.
2. **Progressive enhancement, never a dependency.** The answer streams
   and renders as markdown exactly as today; the pass runs after the
   stream ends and, when it returns, the client swaps classified blocks
   in at their AST positions. The call carries a **2 s timeout**
   (`AbortSignal.timeout(2000)`; planned at 1 s, raised the same day the
   live run measured Jev at 700–800 ms, which left no room for the
   retry), one retry on 429/529 inside that
   budget, and no other retry. Per the decision on #49, this deadline covers
   the HTTP request, not the complete pass. Local confidence recording is
   synchronous afterward and can add SQLite lock-wait latency (the server
   connection has a 5000 ms busy timeout). A timeout, an error, a missing key, an
   answer below the confidence threshold, or a candidate the transform
   cannot map all mean the same thing: the markdown stays. Nothing about
   an answer waits on Jev, and nothing about an answer can be worse for
   Jev having been asked. A classifier that keeps failing is not asked
   (added 2026-09-21, the user's call): after three consecutive failures
   the client opens a breaker and skips the pass for 30 s, doubling on
   every failed probe up to 30 minutes, and one answered probe closes it.
   Bad connectivity then costs one probe per window, never a budget's
   worth of waiting on every answer.
3. **Code extracts, Jev judges, code renders.** Every answer is a
   `choice` or a `noul` over things the surface can name from the text:
   which shape, which header is the recommended column (or none), which
   tone from the kit's fixed sets, whether the first column names
   criteria. Nothing Jev cannot answer from the text is invented — no
   footnote, no delta figure, no source line the text does not carry —
   the same rule the sparse-block fix set in wave 13. The transform's
   output is a `Block` from D41's union, rendered by `BlockCard`; the
   surface learns no new component.
4. **Server side, backend-agnostic, persisted.** The pass lives in
   ui-server at the point the turn's result frame is emitted, so pi and
   Claude get it alike and the key never reaches a browser. Results
   persist with the message (a `blocks` array of `{ anchor, block,
   confidence }`), so history renders identically without a second
   call, and a rerun of the pass is a maintenance action, not a render
   step. On the wire it is one additive frame after the result frame,
   `ServerMessageBlocks`, and a message-history field: `PROTOCOL_REV`
   4, a `CONTRACT:` commit.
5. **Confidence gates the swap.** Start at 0.6 for a swap and 0.8 for a
   tone; below that the block stays markdown and the answer records why.
   Thresholds are measured on the transcript corpus, not assumed —
   TypeSafe calibrates the probabilities, we pick where to act. Measuring
   needs the numbers, and the first cut recorded only the outcome, so a
   `kept` was a count with nothing behind it. The pass now also records
   what it was confident about (added 2026-09-22): one row per answered
   question in `classification_confidence` — the candidate it was asked
   about, its kind, the question, the answer, its confidence, the line that
   confidence had to clear, and whether the candidate ended up drawn —
   written after the call has resolved, so it takes none of the call's
   budget. It is read back with `confidenceDistribution`
   (`packages/ui-server/src/classification/confidence-store.ts`, exported
   from the package root), or straight off the file:

   ```sql
   SELECT candidate_kind, question, threshold,
          CAST(confidence * 10 AS INTEGER) / 10.0 AS bucket,
          COUNT(*) AS n, SUM(cleared) AS cleared,
          SUM(outcome = 'swapped') AS swapped
     FROM classification_confidence
    GROUP BY candidate_kind, question, threshold, bucket
    ORDER BY candidate_kind, question, bucket;
   ```

   One pass's rows share a `pass_id`, so `(pass_id, candidate_id)` names one
   candidate — a minted id rather than the clock, because the pass is fire
   and forget and a session's slow pass can still be writing when the next
   turn's starts. Some questions have to be read per candidate or they are
   meaningless:
   the catalogue asks `criteria_first` of every table, including the ones
   the shape answer calls `data`, so unconditioned its answers are two
   populations stacked on each other (measured 2026-09-22: 12 of 26 at or
   below 0.3, 13 at or above 0.9). Join the candidate back to its own shape
   answer before tuning anything on it.

   Instrumentation, not state: nothing renders or replays from it, a write
   that fails is a log line rather than a block the reader does not get,
   and rows age out after 30 days.
6. **The catalogue is the contract.** The candidate kinds, the questions
   asked of each, and the transform from answers to `Block` are one
   table in ui-sdk (`classification/catalogue.ts`), so a new kind is one
   row plus its transform, and the prompt to Jev is generated from it —
   the same move D3 made for tool briefs. First cut: table →
   comparison | data | plain (+ recommended header, + criteria-column
   noul); ordered list → steps | plain (+ variant); bullet list → schedule
   | timeline | plain; key-value run → receipt | stats | contact | plain
   (+ contact kind, + per-row value tone); blockquote → quote | plain
   (+ quote tone, + "next line is the source" noul); number series →
   trend | plain (+ delta tone).

**Alternatives refused.**

- *Deterministic heuristics alone*: they separate a table from prose but
  not a comparison from a data table or a recipe from a timeline, and
  every rule is a future bug report. Heuristics stay for what they are
  good at — finding candidates — and hand the judgment on.
- *Asking the answering model to classify its own output*: a second
  frontier call per answer, seconds not milliseconds, and it generates
  text that must be parsed.
- *Client-side classification*: the key would ship to the browser.
- *Blocking the render on the pass*: refused by the user's own rule and
  by wave 13's — a table the reader can see beats a kit table 400 ms
  later.

**Not decided here.** Whether `show_block` is still worth its brief once
the net exists (measure the tool's use rate after wave 14). Cells with
inline markup render plain until the kit's table cells accept nodes,
which is the kit's decision. Whether the pass should also run over the
share PNG's source.


## 2026-09-22 — D43: the `show_block` brief stays, because it is the tool's only discovery path

**Question.** D42 left it open: "whether `show_block` is still worth its brief
once the net exists (measure the tool's use rate after wave 14)". The brief
rides every turn, and the premise for retiring it was wave 13's number — five
comparison prompts, zero tool calls, after the prompt had been rewritten twice
— plus the classification pass now catching the common case structurally. If
the model never calls the tool for what the pass already reaches, most of the
brief is being paid for on every turn and returning nothing.

**Method.** `scripts/measure-show-block.ts`, an A/B over the **Claude
backend's** real SDK options — every rate in this record is that backend on
`claude-sonnet-5`, and the pi section below says why that qualifier is
load-bearing rather than pedantic. Nine prompts, two arms, six repetitions: 108
live turns, against a copy of `packages/core/fixtures/corpus/`, $7.15 of
API spend. The arms differ in exactly one thing — `buildSystemPromptAppend`'s
`tools.block`, which is what puts the brief in the system prompt. The tool is
registered, allowed and byte-identically described in both, so the `no-brief`
arm is precisely the "retire the brief, keep the tool" shape. Production's own
`createAgentHook()` is registered, so the 18 turns that delegated behaved the
way they do there rather than losing a backgrounded subagent at turn end;
18 of the completed turns delegated, 24 of all 108.

Four rules decide what counts, and each of them changed a number:

- **Only calls that would have rendered.** The argument has to parse through
  the contract's own schema; a rejected call drew nothing. An earlier run had
  three.
- **Subagent frames are not the answer.** `parent_tool_use_id` is non-null on
  frames a subagent produced, and the chat adapter keeps those off the surface.
- **The turn budget is enforced, not just advertised.** Production aborts a
  turn at `turnTimeoutMs` (`timeoutHandle = setTimeout`,
  `packages/ui-server/src/ws/run-session.ts:326`), so
  the harness aborts at the same 180 s. Without it an answer no reader could
  have received still scored: an earlier run had five turns of 190–306 s.
- **A turn that did not complete is excluded from every rate**, in both
  directions — not counted as declining to call the tool, and a call it made
  before failing does not count either. Six were excluded here, all on the
  budget, five of them `trend` (which delegates, and foreground subagents are
  slow). The exclusions are lopsided — five brief against one no-brief — and
  they fall on a prompt the brief arm otherwise wins, so 59% is if anything
  conservative.

Each turn's text parts then go through `planClassification`, the same entry
point `ui-server` calls, so a turn that did not call the tool is scored for
whether it left the pass a candidate. Detection is necessary but not
sufficient, so a candidate is an upper bound on what the pass would have drawn.

Named divergence from production: `disallowedTools` withholds `Bash`, `Edit`,
`Write`, `WebSearch` and `WebFetch`, where production withholds only
`AskUserQuestion`. `Bash` because the harness runs `bypassPermissions` on a
real host; `Edit`/`Write` because every turn shares one staged brain, so a
mutation would leak into every later turn in both arms; the two network tools
because a live search is neither reproducible nor free. It is identical in both
arms, so it cannot move the contrast — only where both arms sit. Checked
afterwards: every staged brain still matches the fixture corpus byte for byte,
except for an empty `.claude/` the CLI creates beside it, so no turn changed
what a later turn read.

**Numbers.** Claude backend, `claude-sonnet-5`, 102 completed turns of 108.

*Quote this entry from the tables in this section and the always-loaded one
below, never from a sentence — and give a figure that arrives from another
record, another agent or a summary the same treatment before repeating it.*
Five figures in this record had to be corrected within a day of writing it.
Two were numbers restated in prose that drifted from the table they came from.
**Three arrived from outside**: lifted from another document quoting an earlier
version of this one, or taken from one agent's summary of one run when the
pooled data said otherwise. A figure is reconciled against its own primary
table or it is not quoted, whoever sent it. The tables are the record; the
prose cites them.

| arm | turns | a `show_block` call | rate | no call, but a candidate the pass would see |
| --- | --- | --- | --- | --- |
| brief | 49 | 29 | **59%** | 6 (12%) |
| no-brief | 53 | 1 | **2%** | 33 (62%) |

Split by whether the pass can reach the kind — it reaches eight of the eleven
(comparison, table, steps, timeline, schedule, quote, receipt, stats) and has
no route to `trend`, `bars` or `contact`:

| kinds the pass reaches | arm | turns | calls | rate |
| --- | --- | --- | --- | --- |
| yes | brief | 35 | 21 | 60% |
| yes | no-brief | 36 | 1 | 3% |
| no | brief | 14 | 8 | 57% |
| no | no-brief | 17 | 0 | 0% |

> **2026-09-30 — Implementation context (D43's production deferral claim).** The
> [bridge server before D44](https://github.com/schlessera/brain-kit/blob/70e7ed3808c81a6aa5d59ea316dec9888851c155/packages/ui-backend-claude/src/ask-user-tool.ts#L104-L108)
> omitted `alwaysLoad`. The
> [D44 implementation](https://github.com/schlessera/brain-kit/commit/2efd725e233abefca36c25693cd362cf69a0b1bd)
> sets it, under the
> [D44 decision](https://github.com/schlessera/brain-kit/blob/2efd725e233abefca36c25693cd362cf69a0b1bd/docs/decisions/design-kit.md#L2522).
> The following production claim and rate tables describe the pre-D44 runs;
> they do not describe the current bridge-tool posture. The measurements remain
> evidence for D44's choice.

**Why the no-brief arm is near zero, which is the actual finding.** Not
reluctance. The SDK **defers an MCP server's tools behind tool search by
default** — they are not in the model's context at all until it runs
`ToolSearch` — and `packages/ui-backend-claude/src/ask-user-tool.ts:107` does
not pass `alwaysLoad`, so this is production's behaviour and the harness
inherits it. Over the two runs below — **run A**, 108 turns, taken before the
turn budget was enforced and therefore losing none, and **run B**, the 108-turn
run this entry's rate tables report, losing 6 to the budget — 210 completed
turns of 216. The two are a harness generation apart and the table pools them,
which is sound for this quantity because enforcing the budget changes which
turns are counted and not how the model reached the tool. Each run's rows are
printed by the harness itself under "`ToolSearch` against calls", so this is
reproduced rather than hand-assembled, and either generation can be read alone:

| run | arm | completed | ran `ToolSearch` | called `show_block` | called without searching |
| --- | --- | --- | --- | --- | --- |
| A (pre-budget) | brief | 54 | 33 | 33 | **0** |
| A | no-brief | 54 | 1 | 0 | **0** |
| B (enforced) | brief | 49 | 29 | 29 | **0** |
| B | no-brief | 53 | 3 | 1 | **0** |
| pooled | brief | 103 | 62 | 62 | **0** |
| pooled | no-brief | 107 | 4 | 1 | **0** |

**No turn in either run ever called `show_block` without first running
`ToolSearch`, and in the brief arm every turn that searched then called.** The
brief is the only text in the prompt that names the tool, so it is the only
reason the model goes looking. The one no-brief call came from one of the three
turns that searched speculatively.

Forcing the tools into the prompt (`--always-load`, eight prompts x two arms x
three reps, 44 completed turns) settles what the brief is doing. Same prompts,
default configuration on the left:

| `show_block` in the prompt? | brief | no-brief |
| --- | --- | --- |
| behind tool search — what shipped when this was measured | 23 of 43 (53%) | **1 of 47 (2%)** |
| always loaded | 17 of 22 (77%) | **17 of 22 (77%)** |

The two rows are a harness generation apart and it shows in the denominators:
the top row is run B, with the turn budget enforced, and the always-loaded row
was taken before that and is reported over the turns that finished inside the
same 180 s. That is why 22 rather than 24.

Identical, and higher than the brief reaches on its own. **The brief's entire
measured effect is discoverability, not persuasion.** Once the model can see
the tool, the brief adds nothing at all **to the rate**. That qualifier is
load-bearing and it is not a hedge: every figure in this entry scores whether a
block was drawn and never which kind, while the brief's text is mostly about
*which* kind to pick. Nothing here licenses deleting that text — see "What is
not claimed" below, and #157, which is where it is decided.

Per prompt in that loaded condition, which is the table the per-kind claims
below cite:

| prompt | brief | no-brief | combined |
| --- | --- | --- | --- |
| `compare-short` | 3/3 | 3/3 | 6/6 |
| `compare-long` | 3/3 | 3/3 | 6/6 |
| `table` | 3/3 | 3/3 | 6/6 |
| `steps` | 3/3 | 3/3 | 6/6 |
| `bars` | 3/3 | 3/3 | 6/6 |
| `trend` | 1/1 | 1/1 | 2/2 |
| `quote` | 0/3 | 1/3 | **1/6** |
| `contact` | 1/3 | 0/3 | **1/6** |

`trend` has two turns rather than six because the rest exceeded the turn
budget. `quote` and `contact` are the two kinds the loaded model declines, at
the same rate — but only one of them matters, and the difference is not the
rate. A declined `quote` leaves a blockquote, which the classification pass
turns into a `quote` block; that is the designed fallback working. A declined
`contact` leaves prose the pass has no route for (#132), so it leaves nothing.

**The pi backend does not reproduce any of this, and the reason is probably in
the code.** #50 measured pi at the server level and #137 records the gap: on
the same four prompts, same model, same corpus, pi called the tool on 52 of 60
counted turns (87%) across two runs against this record's 59% brief-arm rate in
the table above (pooling those two runs is sound because each pi turn is its
own session — `scripts/measure-show-block-server.ts`, which ships with #149
and is not in the tree yet, clears state per turn —
and because that harness excludes turns that never reached a result, the same
discipline as this one; the reason offered for it, that the classification pass
runs after the result frame, is true but answers a different question, since it
rules out the pass contaminating a turn rather than establishing that two runs
sample the same thing), and on the two prompts this record measured at zero — "Compare Bun and
Node.js … keep it short" at 6 of 6, `contact` at 3 of 6. (Figures from #137; an earlier
pi pass on `claude-sonnet-4-6` drew a block on 21 of 23 turns, which is a
different run and not the one above.) **No pi turn was run or re-scored for
this entry.** Every pi number here was reconciled against #137's own per-run
table for arithmetic and provenance before being repeated, which is a weaker
claim than having reproduced it, and the two should not be confused.

**pi has no deferral.** It registers `show_block` as a plain `ToolDefinition`
in its own tool list (the `showBlock` definition, `const showBlock`,
`packages/ui-backend-pi/src/bridge-tools.ts:266-277`, and the unconditional
push into `tools`, `const tools: ToolDefinition[]`, `:279-282`);
there is no MCP server, no tool search, and no `alwaysLoad` to set, so the tool
is in the prompt on every pi turn by construction. That makes pi's shipping
configuration the structural equivalent of this record's `--always-load`
**brief** arm — and only that one. pi has no no-brief arm and no supported way
to have one: `block: "show_block"`,
`packages/ui-backend-pi/src/session-resources.ts:157` passes the
block brief unconditionally, where the four lines above it gate their briefs on
a capability. So pi can corroborate the loaded *rate* and can say nothing at
all about whether the brief matters; the 77%/77% here and #148's 76%/77% are
one backend measured twice, not two backends agreeing. It is also not the
Claude backend's configuration as this entry measured it, and `--always-load`
is the controlled
version of the same comparison: it flips deferral alone, on one backend, one
model, one host. Flipped, this backend also calls on `compare-short` — 3 of 3
in both arms, against 0 to 6 of 6 depending on the run when deferred — and also
stops caring whether the brief is present.

What that does NOT settle, and #137 owns:

- **The remaining height.** pi's 87% over 60 turns against 77% always-loaded
  here, and #148's 76–77% over 47–48 on the shipped configuration, is a real
  gap of about ten points, and deferral does not explain it.
- **`contact`.** 3 of 6 on pi against 1 of 6 loaded here. Six turns a side is
  not enough to call a difference, and this record should not be read as
  having found one.
- **The method difference.** #50 drives the whole server over a socket; this
  harness drives the Agent SDK directly. #137 names a host-isolation confound
  on the Claude side of its own comparison that has to be closed first.

The prediction this makes is falsifiable, and #148 has since checked it: if the
Claude backend adopts `alwaysLoad: true`, its numbers should move toward pi's
87% rather than merely upward. **They landed at 76–77%, short of it.** In
points, which is the only form that does not depend on a chosen baseline:

| step | rate | moved |
| --- | --- | --- |
| Claude, deferred, no brief | 2% | — |
| Claude, deferred, brief (this entry's headline) | 59% | +57, the brief |
| Claude, always-loaded (#148, shipped) | 76–77% | +17 to +18, the loading |
| pi, always-loaded by construction | 87% | **+10 to +11, unexplained** |

Stated as a fraction it is whatever the denominator is chosen to be — an
earlier revision of this entry said "roughly a third" without showing which,
which is the failure this entry's own quoting rule is about. Ten points is the
measured distance and it is what #137 owns. So the
prediction partly failed, which is the useful outcome — deferral is not the
whole cause, and whatever else separates the two backends is #137's to find.
About ten points of the gap this record attributed to deferral is unexplained
by it, now on 60 pi turns against 47–48, which is better powered than the
comparison #137 was filed with and did not close.

**Decision. The brief stays, unchanged.** On the Claude backend, in the
configuration this entry measured — tools deferred behind tool search, which
#148 changes the same day — it is
not encouragement to use a tool the model can already see; it is the only thing
that tells the model the tool exists. Retiring it does not lower the rate from
59% to something smaller — it takes the rate to the noise floor and makes three
block kinds unreachable by any path. It costs 257 input tokens per turn (11
lines, 749 characters, counted by `count_tokens` rather than estimated), and
`packages/ui-sdk/tests/tool-contracts.test.ts` pins both budgets at what was
measured — eleven lines, down from `< 15`, and 749 characters, because eleven
long lines cost more than twelve short ones.

"Shorten it to the kinds classification cannot reach" loses for the same
reason, and more sharply than the split table alone would show: a brief naming
only `trend`, `bars` and `contact` leaves the other eight kinds
*undiscoverable*, not merely unencouraged. D42's own rule is that no code path
may depend on the classification pass having run — and where the pass cannot
reach at all, its fallback is not a missing block but a wrong one: the
`no-brief` turns on `trend` and `bars` left `table` candidates, which would
have drawn a data table where the answer was a trend.

**What this corrects in D42.** D42 opens "wave 13 measured the comparison
prompt at 0 of 5 … prompt text is not the lever." Its decision stands and the
pass earns its place, but that framing is now wrong twice over. Four of those
five runs were the same prompt, and the deferral finding says the brief is not
"prompt text" in the sense that sentence means — it is the tool's discovery
path, and removing it removes the tool. The lever that actually governs the
rate is neither the brief's wording nor the pass: it is whether the tool is in
the prompt at all.

**Three findings this surfaced, filed rather than fixed here.**

- `alwaysLoad: true` on the bridge MCP server reaches 77% with no brief at all.
  That is the real lever and it may supersede the brief entirely, but it
  changes the backend rather than the advertisement, which #45 scoped out.
- `contact` is barely reachable by anything: 0 of 12 across both default arms
  and 1 of 6 with the tool loaded. It is not uniquely low — `quote` is also 1
  of 6 loaded — but it is uniquely *consequential*, because a declined `quote`
  still reaches the reader through the classification pass and a declined
  `contact` reaches them as prose.
- The pass has no route to `contact` or `trend`, though D42's decision 6
  specifies both. Every transform in `classification/catalogue.ts` returns one
  of eight kinds and `CandidateKind` has no number series. That is a
  discrepancy between this record and the code, not a measurement result.

**What is not claimed, and this is the limit that matters most.** Every figure
here scores *whether* a block was drawn, never *which kind*. A model that
reaches for `table` where `comparison` was right, or `timeline` where
`schedule` was right, scores identically in all of it. So "the brief's entire
measured effect is discoverability" is a claim about the **rate** and says
nothing about whether its content — which is mostly *which* kind to pick —
does work. Nothing measured anywhere yet answers that, on either backend.

#50's kind-correctness pass on pi — 23 of 25 scorable turns drawing the right
kind, with one systematic miss (`schedule` prescribed, `timeline` drawn, 2 of
2) — is sometimes read as evidence the brief's content works. It is not, and
this record refused the same move 100 lines above: pi has no no-brief arm, so
every pi turn was measured **with the brief present** and a single-arm result
cannot attribute anything to it. What that pass does establish is narrower and
still useful: **kind-correctness is a dimension with real variance**, it can be
scored, and a systematic error lives in it that every rate table on both
backends is blind to. That is a reason to measure the brief on kind-correctness
before touching it, not evidence of how that measurement will come out.

So nobody should read the 77%/77% as licence to delete the brief's text, and
nobody should read pi's 23 of 25 as licence to keep it. #157 is where it is
decided and it needs a two-armed, kind-scored measurement, which nothing has
run.

Per-prompt rates are noisy — `compare-short` measured
0 of 6, then 5 of 6, then 6 of 6 across three runs of the corrected harness,
because the variance is in whether the model spends a `ToolSearch` round-trip,
not in whether it wants a block. Only the arm-level contrast is stable, and it
is stable because it is a discoverability effect rather than a preference. One
model, one backend: every number here is `claude-sonnet-5` on the Claude
backend, driven through the Agent SDK directly. A reader who takes any of them
as "the block rate" will be wrong on pi, and wrong on this backend too once
`alwaysLoad` ships. `scripts/measure-show-block-server.ts` — #50's harness,
which arrives with #149 and is not in this tree — is the instrument for the
other level — it drives the whole server over a real socket
and is backend-agnostic, so it sees the classification pass, the wire frames
and the client that this harness, sitting below all three, cannot.

**Reproducing it.** `bun scripts/measure-show-block.ts --reps 6 --concurrency 6
--out runs.json --md report.md`, with `ANTHROPIC_API_KEY` set. The
always-loaded table is a different shape — eight prompts at three reps, not
nine at six, with `recommend` the one this entry's nine that it omits:

```sh
bun scripts/measure-show-block.ts --always-load --reps 3 --only \
  compare-short,compare-long,trend,contact,table,steps,quote,bars
```

It is a script and not a test: it needs
the network and a key, so CI never runs it. Re-run it before changing the brief
again.

## 2026-09-22 — D44: the bridge tools are always loaded, not deferred behind tool search

**Question.** D43 ended with a filed finding rather than a decision:
`packages/ui-backend-claude/src/ask-user-tool.ts` created the `brain-ui` MCP
server without `alwaysLoad`, so the Agent SDK deferred all five bridge tools
behind tool search, and forcing them into the prompt reached 77% with no brief
at all. #148 asked whether that is the configuration that should ship. It is an
arithmetic question and nobody had done the arithmetic.

**What the SDK actually offers**, checked against the installed
`@anthropic-ai/claude-agent-sdk@0.3.278` rather than recalled:

- `createSdkMcpServer({ alwaysLoad: true })` stamps
  `_meta["anthropic/alwaysLoad"]` on every tool it registers. Leaving it unset
  is deferral, and that is the default.
- **A per-tool split is possible.** `tool(name, description, schema, handler,
  { alwaysLoad })` exists and is OR'd with the server-level flag, so "load some
  and not others" was a real option; it is rejected below on its merits rather
  than for being unavailable. The same extras object carries `searchHint`,
  which steers the search index. Nothing in the tree sets one.
- **The startup-latency objection does not apply the way it reads.** The
  warning that `alwaysLoad` "blocks startup until the server is connected
  (capped at the standard 5s connect timeout)" is attached to
  `McpStdioServerConfig`, `McpHttpServerConfig` and `McpSSEServerConfig` — the
  out-of-process transports — and it describes a **server-config** flag. The
  CLI's startup-wait filter reads `config.alwaysLoad` and, once tool search is
  on, waits only for servers that set it. `createSdkMcpServer` does not put
  the flag on the config it returns: it stamps `_meta["anthropic/alwaysLoad"]`
  on each registered tool and hands back a plain
  `{ type: "sdk", name, instance }`. So this change never enters that wait set,
  and the in-process server has nothing to connect to in any case. The reading
  that matters is the empirical one below: first frame did not move.
- The deferral is the API's mechanism rather than a client-side index: the
  shipped CLI binary contains `defer_loading`, `tool_search_tool_regex` and
  `tool_search_tool_bm25`, which is what makes both shapes priceable by
  `count_tokens`.

**The arithmetic, counted rather than estimated.**
`bun scripts/measure-show-block.ts --tokens` takes the schemas from the real
server — `createBrainUiMcpServer` with every handler supplied, listed over an
in-memory MCP client, which is the serialisation the CLI forwards — and prices
them with `count_tokens` on `claude-sonnet-5` in the two shapes the API
receives: a plain tool definition, and one carrying `defer_loading: true`
beside a tool-search tool. Both columns are measured against the same floor (a
search tool plus one undeferred tool, 682 tokens), so what is left is what this
decision is responsible for.

| bridge tool | in the prompt | its brief | brief lines |
| --- | --- | --- | --- |
| `show_block` | **5270** | 256 | 11 |
| `ask_user` | 756 | 87 | 4 |
| `query_activity` | 552 | 108 | 4 |
| `request_image_mask` | 383 | 110 | 5 |
| `get_current_location` | 374 | 94 | 4 |
| **all five** | **7335** | **655** | 28 |

Deferred: **93 tokens** for the whole set, and the same 93 for one deferred
tool as for five — the API prices the deferred set as a fixed block rather than
per tool. Both figures are insensitive to which tool-search tool is declared
alongside them: `tool_search_tool_bm25_20251119` and
`tool_search_tool_regex_20251119` give 93 and 7335 alike, differing only in
their own weight (682 against 710), which is subtracted as the floor either
way. The five per-tool rows sum to the measured all-five figure exactly
(374 + 756 + 552 + 383 + 5270 = 7335), so the floor subtraction is linear here
rather than hiding a per-request constant.

The brief column is counted the same way but against its own floor — the same
system prompt with and without that brief, no tools declared in either request.
Each column is a delta against a matched baseline; the two columns are not
measured in the same request and should not be added to a single "what the
prompt costs" figure.

Ten to one, then, and `show_block` is 5270 of the 7335: 72% of the bridge
surface is one eleven-variant union, 11,452 serialised characters of which
11,319 are a flat `oneOf` with no `$defs` and no `$ref`. **That ratio is the
number this decision was expected to turn on, and it is not what decided it.**

**The measurement.** `scripts/measure-show-block.ts`, nine prompts, two arms,
three repetitions, run once in each configuration: 108 live turns on
`claude-sonnet-5` against a copy of `packages/core/fixtures/corpus/`, $11.43 of
API spend, **every turn completed in both runs**. D43's counting rules carry
over unchanged — only calls whose argument parses through the contract's schema
count, subagent frames are skipped, an incomplete turn is excluded from every
rate. Two columns are new: per-turn input tokens as the SDK reports them, and
wall time to the first assistant frame.

| configuration | arm | a `show_block` call | ran `ToolSearch` | input per round-trip | first frame |
| --- | --- | --- | --- | --- | --- |
| deferred — what shipped | brief | 14 of 25 (**56%**) | 15 | 24,087 | 3897 ms |
| deferred | no-brief | 0 of 25 (**0%**) | 0 | 21,088 | 4549 ms |
| always loaded | brief | 19 of 25 (**76%**) | 0 | 26,694 | 4371 ms |
| always loaded | no-brief | 20 of 26 (**77%**) | 0 | 27,522 | 4716 ms |

**These runs were taken on the harness before `e017715` enforced the 180 s turn
budget it advertises**, which is the same correction that moved D43's
always-load arm from 19 of 24 to 17 of 22. Seven of the 108 turns ran over, six
of them the `trend` prompt, and the table above already excludes them the way
the enforced harness would. Left in, the four cells read 56%, 0%, 78% and 78%
over 27 turns each; the conclusion does not move either way, and the enforced
figures are published because they are what a re-run will produce.

D43's 77%/77% replicates at 76%/77%. Across the two runs that is 47–48 turns
per cell agreeing: **once the tool is in the prompt, the brief changes
nothing** — on rate, which is the only thing any of it measures.

The two no-brief arms isolate the schema as cleanly as this harness can —
neither searches, so the only difference between them is the schema in the
prompt: 21,088 against 27,522, a delta of **6434** against the 5270
`count_tokens` priced. Over non-delegating turns only, where `usage`'s
main-loop scope and `num_turns` cannot disagree, it is 20,279 against 26,296, a
delta of **6017**. The live run brackets the counted figure rather than
reproducing it: it confirms the sign and the order of magnitude, which is what
the decision rests on, and not the third digit.

A note on provenance, because the two tables below do not share a source. The
token columns come from the result message's `usage`, which the SDK documents
as the main agent loop only, divided by `num_turns`; the dollar column comes
from `total_cost_usd`, which covers the whole query pipeline including
subagents. Nothing here reasons across the two — the token claim and the cost
claim are made separately, and the cost table excludes delegating turns for
exactly the reason the scopes differ.

**What it costs, which is the part the ratio got wrong.** Turns that delegated
to a subagent are excluded from the cost comparison — a subagent's bill is
several times the turn's own and the two runs drew a different number of them
(11 and 10), so leaving them in measures delegation rather than loading.

| configuration | arm | turns | $ / turn | median $ / turn | rate |
| --- | --- | --- | --- | --- | --- |
| deferred | brief | 21 | $0.0559 | $0.0550 | 57% |
| deferred | no-brief | 22 | $0.0383 | $0.0327 | 0% |
| always loaded | brief | 23 | **$0.0594** | $0.0472 | 78% |
| always loaded | no-brief | 21 | $0.0475 | $0.0419 | 81% |

**Like for like, always loading the tool raised the bill by 6%** — not by the
ten to one the token ratio implies, and not by the 24% the isolated no-brief
comparison shows either. The reason is that the deferred configuration does not
avoid the schema; it postpones it. A tool search **appends** the matched
definition rather than swapping it, so from the search onwards every remaining
round-trip of that turn carries the full 5270 anyway — and the turn has also
paid for an extra model round-trip to get it. Measured across the shipped
configuration: turns that ran `ToolSearch` billed 25,715 input tokens per
round-trip against 21,247 for turns that did not. **Deferral saves the schema
only on the turns that never wanted the tool.**

First frame did not move in any direction the samples can distinguish
(3883–4449 ms deferred, 4277–4620 ms loaded; medians 3185–3804 against
3263–3553). The in-process server has no connect step to block on, and the
numbers agree.

**Decision. `createBrainUiMcpServer` sets `alwaysLoad: true`.** The bridge
tools ride every prompt. 20 percentage points of call rate for 6% of a turn,
no measurable latency, and the end of a structural fragility: under deferral a
tool's existence depended on a line of prompt text, so an editor shortening a
brief could silently remove a tool and no test would notice. That is not a
trade-off anyone would choose on purpose, and D43 found it by accident.

`tests/bridge-tools.test.ts` ("bridge tool loading posture") holds it: every
registered bridge tool carries `_meta["anthropic/alwaysLoad"]`, with a
companion test registering the same factory without the flag and asserting the
meta is absent, so the first assertion cannot pass vacuously.
`packages/ui-backend-claude/tests/sdk-options-mcp.test.ts` holds the same thing
one level up, over the `mcpServers` entry `createClaudeSdkTurn` actually builds
— the factory being right is not the same claim as the call site using it.

One thing this was checked against and does not do: it introduces no new cache
invalidation. The tools block is the first cache segment and this makes it the
largest, so a roster that varied between turns of a session would now be
expensive. It does not vary. `createBrainUiMcpServer` registers a tool when the
host supplies its handler, and the handlers come from the host's own
configuration (`packages/ui-server/src/ws/bridge.ts`) rather than from anything
the client reports per turn, so the set a session starts with is the set it
keeps.

**Why not keep deferral.** Its case is the 7335-against-93 ratio, and the live
run says that ratio does not reach the bill. Its second argument — that D42's
classification pass already reaches eight of the eleven kinds, so the extra
calls are redundant — holds as far as it goes, and the split table says the gain
is indeed concentrated there (9 of 18 to 15 of 18 on pass-reachable kinds, 6 of
9 either way on the three the pass cannot reach). But D42's own rule is that no
code path may depend on the pass having run: it needs a key, a live classifier
inside 2 s and an answer over the confidence gate, and a deployment missing any
of those gets nothing on those eight kinds unless the tool fires. Redundancy
with a conditional path is not redundancy.

**Why not a per-tool split.** The SDK allows one, so it was considered rather
than assumed away. It loses on coherence: the only tool with a measured
discoverability gap is also the expensive one, so loading "just the cheap four"
spends 2065 tokens on tools that have no measured problem and leaves the one
that does behind the search — and a surface where four tools are found one way
and the fifth another is a thing every later reader has to be told.

**Why `searchHint` is still unused.** It steers the search index, and the
search index is not where the loss was: over 54 turns in the deferred
configuration, 16 ran `ToolSearch` and 15 of those called `show_block`. The
search found the tool essentially every time it ran. The loss was in the model
not running one — and with the tools loaded there is no search to steer.

**What this means for backends that are not the Claude SDK.** Deferral is a
property of the Claude Agent SDK, not of the bridge, so this decision is scoped
to that backend. The backend-neutral obligation is one line: **a bridge tool
has to be in the model's context, and each backend says how.**

D43's pi section above already establishes that pi has no deferral to apply to
a statically registered tool and that its shipping configuration is therefore
the structural equivalent of the `--always-load` **brief** arm and of that one
only — pi has no no-brief arm, so it corroborates the loaded *rate* and says
nothing about whether the brief matters. That ground is not re-covered here. One detail found independently while deciding this and worth
adding to it: the mechanism is `splitDeferredTools` in pi's shipped bundle,
which puts a tool in the deferred set only when an earlier tool result added it
to the conversation and nothing has called it since. A statically registered
`ToolDefinition` can never satisfy that, which is why the absence of deferral
is structural rather than a default someone could flip.

What this decision adds to #137 is only that the Claude side has now moved: the
two backends were being compared across a configuration difference, and after
this they are not. The remaining height between them — **87% on pi over 60
turns against 76–77% here over 47–48**, roughly ten points — is #137's to
explain, and this entry makes no claim about it. The pi figure is the pooled
one over both runs (27 of 30 and 25 of 30); the 90% that circulated is the
first run alone, reported before a second existed, and the spread between them
is what 30 turns of sampling noise looks like on this measurement.

**One cross-backend result that outlives this decision.** The misses on the
always-loaded Claude arms are not spread thin — they concentrate in two kinds.
`contact` is 0 of 3 in both arms and `quote` 0 of 3 and 1 of 3, while six other
prompts are 3 of 3. On pi, pooled over 60 turns, `contact` is 5 of 12 and
`quote` 3 of 4, with every other prompt at full marks. **The same two kinds, on
two backends, in two different harnesses.** Two small samples agreeing is not a
result, but it is a better lead than a rate gap, and it is what #137 and #119
should be pointed at rather than the ten points.

**The two backends do not fail the same way, and the distinction is on two
different axes.** The concentration above is a *call-rate* one: which kinds the
model declines to draw at all. pi's one *wrong-kind* error is a different
dimension — `schedule` prescribed and `timeline` drawn, 4 times out of 4, a
kind reached reliably and reached for the wrong question, which a call-rate
metric cannot distinguish from a success. So `contact`/`quote` and `schedule`
are not two readings of one phenomenon and should not be merged into one.

That `schedule` miss carries one fact worth having before #157 is worked. The
clause the model failed to follow is stated **twice**, in near-identical words:
the brief says "`schedule` for what is coming", and the description says
"schedule: what is coming, grouped by day" (`schedule: what is coming`,
`packages/ui-sdk/src/tool-contracts/blocks.ts:727`, where it sits in the same
sentence as the `timeline` clause). The model drew the wrong one 4 of 4 with
both surfaces saying nearly the same thing. **Saying it twice did not fix the
miss** — which is evidence for the description-overlap arm on #157 and against
assuming duplication is harmless redundancy.

**The SDK-level harness used for this entry does not score kind at all**, only
the server-level one does, so any future Claude-against-pi comparison has half
an instrument until that changes — and a per-brief A/B has to score kind on
both sides, because the two backends' failures do not overlap.

**The prediction, with the condition that would falsify it.** If deferral is
the whole of the difference, this change moves the Claude backend *toward* pi's
87% and not merely upward from 56%. It has already landed at 76–77% in the
measurement above, which is short of pi on a better-powered comparison than
#137 was filed with — 60 turns against 47–48 — and the gap did not close. **That shortfall is the prediction
failing, not confirming**, and it says something besides deferral is also in
play — so #137's search stays live and this entry does not close it. The
honest claim is narrower than "the backends now agree": the configuration
difference is gone, and a residue of roughly thirteen points is not.

Two things stop that residue being read as a like-for-like gap, and both cut
against reading pi as a second replication of the brief result. pi is on a
different harness driving the model directly, and — this is the one that matters
— **pi has no no-brief arm and no supported way to have one.**
`block: "show_block"`, `packages/ui-backend-pi/src/session-resources.ts:157`
passes the block brief into `buildSystemPromptAppend` unconditionally, not
behind a capability check like `askUser`, `location`, `activity` and `mask` on
the lines above it. So every pi number was measured with the brief present. The
77%/77% and 76%/77% cells are one backend measured twice, not two backends
agreeing.

**A consequence for the brief that only exists because of this decision.**
Deferred, `show_block`'s *description* was not in the prompt either — it
arrived with the tool when a search fetched it — which is why D43 found the
brief was the only enumeration of the eleven kinds the model could see without
searching. Always-loading puts the description in every prompt, and the
description names all eleven kinds too: 11 of 11, with nothing in the brief's
enumeration that the description omits (2107 characters against the brief's
749). D41's decision 6 divides them — *"The brief says WHEN, the description
says HOW"* — and the brief does not honour it, enumerating all eleven with a
clause each. Under deferral that duplication was load-bearing. Under this
decision it is duplication, and the eleven kind names now ride every turn
twice. That is not a reason to cut anything here — nothing has been measured
against it, and the kind names are the one part of the brief whose removal a
rate metric could not detect — but it is a fact this decision created and #157
is where it is priced.

**What this changes in D43.** Its decision — the brief stays — stands, and its
measurement is the evidence this entry rests on; the deferral finding is D43's,
not this one's. What this supersedes is its *reason*. D43 kept the brief
because removing it took the rate to 2%, and that was true only of the
deferred configuration. With the tools loaded, the brief measures at no effect
at all: 76% with it and 77% without it here, 77%/77% there, 47–48 turns per
cell.
The brief is no longer the tool's discovery path, so whether it earns 655
tokens across five tools has to be re-argued on its own merits rather than
inherited. **#148 scoped the brief's wording out of this decision, so nothing
about it changes here** and its budget in
`packages/ui-sdk/tests/tool-contracts.test.ts` is untouched at eleven lines and
749 characters — now a ceiling on drift rather than evidence that the lines
earn their place. The question is #157.

**What is not claimed.**

- **Every rate in this entry scores whether a block was drawn, never which
  kind.** A turn that reached for `table` where `comparison` was right counts
  as a call in all of it, in both configurations and both arms. So "always
  loading raises the rate from 56% to 77%" is a claim about reaching for the
  tool and not about the answer being better. **Nothing here should be quoted
  as evidence that the surface draws the right block.**

  The same distinction applies to the brief, and it is the one most likely to
  be misused. The brief's text is mostly about *which* kind to pick rather than
  whether to pick one, so "the brief measures at no effect once the tools are
  loaded" is a **rate** claim, and reading it as a **content** claim is a
  category error. This entry's runs and D43's both support the first and
  neither touches the second.

  **Nothing else touches it either, and #50's kind-correctness pass on pi is
  not the exception it looks like.** Every pi turn was measured with the brief
  present — `packages/ui-backend-pi/src/session-resources.ts` passes it
  unconditionally and pi has no supported way to run without it — so it is a
  single-arm result and attributes nothing to the brief's content, in either
  direction. An earlier revision of this entry said it "points the other way"
  and "suggests the brief's content does measurable work". **Both are wrong for
  the reason this entry already gives about pi elsewhere**, and they are
  recorded here rather than quietly deleted because the same overreach reached
  D43 and was caught there by review.

  What the pass does establish is narrower and worth having: **kind-correctness
  is a scorable dimension with real variance, and a systematic error lives in
  it.** Pooled, 44 of 48 scorable turns drew the prescribed kind, and the whole
  of the error is one clause — `schedule` prescribed, `timeline` drawn, 4 times
  out of 4. So: nobody should read 76%/77% as licence to delete the brief's
  text, and nobody should read 44 of 48 as licence to keep it. #157 makes
  kind-correctness its metric, and that is a reason to measure before touching
  it rather than a prediction of how the measurement will come out.
- **Every figure here that came from another record was reconciled against
  that record's own primary table before being repeated, and the ones that
  could not be are named.** pi's 87% is read off #50's per-run breakdown (27 of
  30 and 25 of 30) rather than from a summary; D43's cells are read off D43's
  tables. Three of the five figure corrections in this lineage today arrived
  from *outside* the record — lifted from another document quoting an earlier
  version, or from one agent's account of one run — rather than drifting inside
  it, which is a different failure from prose disagreeing with its own table
  and needs the same discipline applied to inbound numbers, whoever sent them.
  What this entry cannot claim: **no pi turn was re-run or re-scored here.**
  Every pi number is #50's measurement, checked for arithmetic and provenance
  and not reproduced.
- One model (`claude-sonnet-5`, pinned so a re-run compares like for like) and
  one brain, a copy of `packages/core/fixtures/corpus/`. A larger brain means a
  larger base prompt, so the 7335 is a smaller share of it — and also more
  round-trips to pay it on.
- The cost figures are 21–23 turns per cell, and they are the least stable
  numbers here: mean and median disagree by up to 20% within a cell. The
  direction is consistent across both statistics and both arms; the magnitude
  is not to be quoted to two figures. **"6%" is the mean-to-mean figure in the
  brief arm and it is the weakest number in the headline** — the same
  comparison by median runs the other way, because the deferred arm's search
  round-trips sit in its tail. What both statistics agree on is that the ten to
  one the schemas imply is not what the turn pays.
- The two runs were taken in different windows against a shared rate limit, so
  wall-clock durations are not comparable between them and no claim here rests
  on one. First-frame latency is reported because it is what #148 asked for,
  and the honest reading of it is "no detectable difference", not a number.
- Only `show_block` was registered in the measured server, as it was in D43, so
  the live arms measure 5270 tokens of schema and the 7335 figure is the
  arithmetic for the roster a fully wired deployment registers. The four other
  tools' briefs have never been A/B'd against anything.
- `count_tokens` prices the deferred set as a flat 93 tokens whether one tool
  is deferred or five. That is the API's own accounting and it is what gets
  billed, but it means this entry cannot say what a sixth deferred tool costs.

**Reproducing it.**

```sh
bun scripts/measure-show-block.ts --tokens
bun scripts/measure-show-block.ts --reps 3 --concurrency 6 --out deferred.json --md deferred.md
bun scripts/measure-show-block.ts --always-load --reps 3 --concurrency 6 --out loaded.json --md loaded.md
```

Both need `ANTHROPIC_API_KEY` and the network; CI runs none of it. Note that
the harness's default arms now measure the shipped configuration only when
`--always-load` is passed, because what ships changed — the flag's name is left
alone so D43's invocations keep reproducing D43's tables.

**Re-checking it on a later runtime (#209).** The measurement above names only
the SDK. Its CLI half — the stamp reaches the model undeferred, and the server
config carries no `alwaysLoad` so the in-process server never joins the
startup wait set — is now the `d44-always-load-reaches-the-model` case of
`scripts/measure-claude-runtime.ts`, keyless, against the runtime
`MEASURED_RUNTIME` names. The latency and rate halves still need a live
model: `bun scripts/measure-show-block.ts --both-arms` runs both load modes in
one invocation and records the Claude Code version of every turn.

## 2026-09-22 — D45: the pass routes to `contact`; `trend` stays the tool's, because its payload is numbers

**Question.** D42's decision 6 names six catalogue routes. Two of them were
never built, and nothing recorded a decision to drop them (#132): `contact`
from a key-value run, and `trend` from a number series — together with the
per-row value tone named in the same sentence as the first. `bars` is not in
that list, so the gap is exactly the two routes the record claims are covered
and the code does not have. The question is per route: build it, or correct the
record.

**Decision.**

1. **`contact` is built, from the key-value run D42 names.** The run's `shape`
   question gains a fourth option, and the transform draws a `ContactCard` from
   the lines the text already has. The block's `label` is required and a run
   does not say which line is the name, so a `subject` question asks the
   classifier to choose one of the run's own keys, or `none` — the same move
   the table row's `recommended` question already makes over its headers. The
   chosen line's value becomes the label, the remaining lines become the card's
   facts, and a `contact_kind` question fills D42's "+ contact kind". A run the
   classifier calls a contact but cannot name stays markdown: a label the text
   does not carry is one the surface would be inventing, which
   `docs/integration-contract.md` already forbids.

2. **`trend` is not built, and D42's "number series → trend | plain (+ delta
   tone)" is withdrawn.** Three reasons, in the order that decided it.

   *Its payload is numbers, and the pass only ever passes strings through.*
   `trend.values` is a `number[]` and `bars.pct` is a `number`; those two are
   the only members of D41's eleven whose payload is not text the answer
   already contains — checked against the schemas rather than read off, and
   asserted by a test, because the whole entry rests on it. Every transform in
   the catalogue hands the kit the candidate's own strings verbatim; the only
   text any of them authors is a fixed label, the one-group schedule's "Coming
   up", and never a value. A `trend` route would have to turn
   "1,200", "$1.2M" or "12%" into numbers — a parse with no ground truth and a
   locale ambiguity a reader cannot see ("1.200" is twelve hundred in one place
   and one-point-two in another), feeding a sparkline whose shape is the claim.
   That is precisely the reason D42 gave for never routing `bars`. It applies
   to `trend` unchanged, and D42's route list was inconsistent on the point;
   this entry makes it consistent. The consumer rule it also satisfies is
   already written down: *"Blocks contain only what the text carried. The
   classifier chooses a shape and a tone; it never invents a footnote, a
   figure, or a source line."*

   *There is no gap to fill.* The two routes look symmetric and the
   measurements say they are not. With the tool loaded — the configuration D44
   ships — `trend` fires 3 of 3 in both arms in D43's run and again in #148's,
   while `contact` is 1 of 12 pooled across the same two runs (#119 carries the
   pooled table; the full count across both loading configurations is on that
   issue). A fallback earns its place for the kind the model declines, not for
   the kind it reaches every time.

   *It needs a candidate that does not exist, and the detector under it is the
   part the classifier cannot rescue.* D42 hands judgment to the classifier and
   keeps extraction deterministic. "These lines are a series, oldest first" is a
   judgment and could be asked; "1.2M is 1200000" is extraction, and it is the
   half with no answer in the text.

   What this does **not** claim is that `trend` is unreachable. It is reached by
   `show_block`, where the figures come from an author who knows what they mean
   — which is the right place for a number.

3. **Per-row value tone is built, and bounded.** One `choice` per line of the
   run, with the options named by what the text says rather than by their
   colour ("it reports a failure, an error, or an outcome the reader would not
   want" → red), gated at the tone threshold of 0.8 like every other tone. The
   fall-through option is `none`, not `neutral`: in this kit `neutral` is the
   grey machine-meta accent and means that everywhere, so a value that wants
   the default carries no tone at all and each component falls back on its own
   (`design-feedback.md` §4, `packages/ui-kit/src/types.ts`). Offering `neutral` as "no
   strong reading" would have taught the classifier a meaning the 2026-09-18
   drop retired. It is one question set on the run and whichever branch wins
   reads it, so a
   receipt's rows, a stat tile and a contact's facts are coloured by the same
   answers. It is asked only of a run of eight lines or fewer — the bound stat
   tiles already had, and now the bound on the contact questions too — so the
   question count follows the run's shape and not the text's length. That bound
   is not only editorial: the `subject` question offers one option per line,
   the classifier takes at most 255 of them, and one oversized question fails
   the whole request, which carries every candidate in the message. A run
   longer than a card is asked what shape it is and nothing else, and the
   transform refuses the contact branch on its own rather than relying on the
   answers being absent.

4. **The route list is a test now, not a reading.** Each catalogue row declares
   the block kinds its transform can return, `CATALOGUE_BLOCK_KINDS` is their
   union, and `packages/ui-sdk/tests/classification-catalogue.test.ts` drives
   every declared kind through a real transform and asserts that what is left
   over is exactly `trend` and `bars`. #132 was found by a reader comparing a
   decision record to a file. The next divergence fails a test instead.

**What the pass reaches, after this.** Nine of the eleven: `comparison`,
`table`, `steps`, `timeline`, `schedule`, `quote`, `receipt`, `stats`,
`contact` — every kind whose payload is the answer's own strings. The two it
leaves are the two whose payload is numbers. That is now a sentence with a
reason in it, rather than a count nobody had taken.

**Alternatives refused.**

- *Routing `trend` from the key-value run instead of building a new candidate.*
  A run of `period: figure` lines is nearly what the detector already finds, and
  a `trend` option on the run's `shape` question would need no detector work at
  all. It was the cheapest way to build the route, and it is refused for the
  first reason above: it moves where the route hangs without touching the number
  parse, which is the actual objection.
- *Restricting `trend` to bare integers* (`^\d+$`), which removes the locale
  ambiguity by construction. It also removes the case. A model writing a series
  writes "1,200" or "$1.2M"; a route that fires only on the shape nobody types
  is a route in name.
- *Dropping `contact` as well, on the ground that prose is the right answer to
  "who is this person".* That is #119's question and this entry does not settle
  it. What it settles is narrower and mechanical: when the model **does** type a
  run of facts about a person, the pass now draws it, where before the best it
  could do was a receipt. #119's own reframing is that `contact` was the one
  kind where a low call rate reached the reader as a missing block; after this
  it is a kind whose decline is caught, like `quote`'s.
- *Asking the classifier for the display name as a string.* It generates no
  text by design (D42), and a name is not a judgment. Choosing among lines the
  text already has is.

**What this corrects in D42.** Decision 6's fourth route is now built as
written. Its sixth route is withdrawn, with the reason above; there is no
number-series candidate, no `trend` transform and no delta-tone question, and
the record no longer says there is. The other four routes were already built and
are untouched.

**Known limit, since lifted (2026-09-23, #167).** GFM autolinks a bare email
address or URL, a link is inline markup the kit's cells cannot hold, and so a
run carrying one was not a candidate at all — which removed the most natural
shape a contact has. The maintainer's ruling on #167 narrows the rule for every
candidate kind: a link whose text is its own destination flattens to that text,
since nothing is lost, and a `mailto:` destination reads as the bare address.
A labelled link (`[the docs](https://…)`) still keeps its candidate out of the
pass, because flattening it would drop where it points; so does a link with a
title or an image inside it, and GFM's `www.` form, whose destination adds a
scheme its text does not carry. So the filter is narrower, not gone.
`packages/ui-sdk/tests/classification-detect.test.ts` pins both sides.

## 2026-09-22 — measured: pi draws the block, so the net never gets cast

**Question.** D41 left the tool's use rate to be measured and D42 measured
the classification pass once. Both numbers are the Claude backend's, because
the test deployment configures no other, and D43 has since replaced the
first with a 108-turn A/B. The pi backend had never had a number at all, and
the two backends hand a tool to a model differently enough that the gap was
worth measuring rather than assuming.

**Method.** `scripts/measure-show-block-server.ts`, a companion to D43's
harness rather than a copy of it: that one drives the Agent SDK directly,
which is what an A/B over the brief needs and what pi has no equivalent of,
while this one boots a real ui-server on loopback and drives it with the
shipped client over a real socket, so any backend can be put through the
same measurement. Two runs of the same 32 turns on 2026-09-22,
`claude-sonnet-5` through pi's builtin Anthropic provider, against a copy of
`packages/core/fixtures/corpus/`: the first with the classification pass
off, the second with it on, 18:29:13Z to 18:44:35Z. $2.18 of API spend.
D43's counting rules are carried over — a call counts only when the handler
accepted its payload, subagent frames are skipped, a turn that did not
complete is excluded — and one is added: a turn whose tool arguments named a
path outside the brain answered about a different brain and is excluded too.
Two of each 32 were. Thirty turns counted per run.

The environment can redirect a turn without showing up in a number — a
different endpoint, a different credential store, a different binary — so
what was set is part of the measurement. Both runs: `ANTHROPIC_API_KEY`, and
`TYPESAFE_API_KEY` on the second. `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PATH` and `PI_CODING_AGENT_DIR` were
unset, so the turns went to Anthropic's own endpoint with pi's default agent
directory. The harness records that set of presences with every run and
`--report` prints it.

**pi has no deferral, so this is the always-loaded regime.** `const showBlock`,
`packages/ui-backend-pi/src/bridge-tools.ts:266` registers `show_block` as one
of pi's own `ToolDefinition`s, and pi's `splitDeferredTools` only ever defers a
name that arrived through a tool-result's `addedToolNames` and has not been
called since — a statically registered tool can never be deferred. Across all 64
turns the complete roster the model reached for was `bash`, `show_block`,
`brain_read`, `grep`, `brain_search`, `read_file`, `brain_list`, `brain_graph`:
no search-then-load round trip, ever. The brief is in the prompt on every turn
unconditionally (`block: "show_block"`,
`packages/ui-backend-pi/src/session-resources.ts:157`, not behind a capability
check like the four bridge tools beside it). So pi is the structural twin of
D43's `--always-load` arm and has never run any other configuration.

**The rate.** Each cell is turns that drew at least one accepted block.

| prompt | expected kind | run 1 | run 2 | pooled | right kind |
| --- | --- | --- | --- | --- | --- |
| `compare-short` — "…Keep it short." | `comparison` | 6/6 | 6/6 | **12/12** | 12/12 |
| `compare-long` — the same without it | `comparison` | 6/6 | 6/6 | **12/12** | 12/12 |
| `trend` | `trend` | 4/4 | 4/4 | **8/8** | 8/8 |
| `contact` | `contact` | 3/6 | 2/6 | **5/12** | 5/5 |
| `steps` | `steps` | 2/2 | 2/2 | **4/4** | 4/4 |
| `schedule` | `schedule` | 2/2 | 2/2 | **4/4** | **0/4** |
| `quote` | `quote` | 2/2 | 1/2 | **3/4** | 3/3 |
| project summary | — | 2/2 | 2/2 | **4/4** | not scored |
| overall | | 27/30 | 25/30 | **52/60 (87%)** | **44/48** |

Pooling the two runs is legitimate for this number: the classification pass
runs after the result frame and cannot change what the model did during the
turn. **A figure of 90% circulated before the second run existed** — that is
27 of 30, the first run alone. D43 and D44 both quoted it and both now carry
52 of 60, read off this record's per-run breakdown rather than relayed. The
spread between 90% and 87% is what 30 turns of sampling noise looks like on
this measurement, which is worth knowing before either is treated as
precise. Across all sixty turns the model typed **zero markdown tables**. Two
calls were rejected by the handler, both `comparison`, both on a turn that
retried and succeeded — the same shape D43 saw at three in 108, and the
reason a call is not counted until its payload parses.

Beside the Claude backend, on one axis. The two Claude columns are
independent runs of the same four cells — D43's and D44's, both above —
quoted from those records rather than relayed:

| configuration | Claude, D43 | Claude, D44 | pi |
| --- | --- | --- | --- |
| behind tool search — what shipped, with brief | 23 / 43 (53%) | 14 / 25 (56%) | n/a |
| behind tool search, no brief | 1 / 47 (2%) | 0 / 25 (0%) | n/a |
| always loaded, with brief | 17 / 22 (77%) | 19 / 25 (76%) | **52 / 60 (87%)** |
| always loaded, no brief | 17 / 22 (77%) | 20 / 26 (77%) | unreachable |

D43's deferred rows here are the ones from its own `--always-load`
comparison, so both of its rows come from one run; its headline A/B is a
larger, separate run at 59% and 2%. pi's cell sits on the "with brief" row
and nowhere else: the brief is
hardcoded into pi's prompt, so pi has no no-brief arm and no supported way
to have one. The two Claude no-brief cells are therefore one backend
measured twice and not two backends agreeing.

**pi does not contradict either record; it replicates their always-loaded
arm on a different backend.** What is not accounted for is the remaining
height — **87% against 76–77%**, on 60 turns against 47–48 across the two
Claude runs. Three things could explain it and none is measured: the layer
(both Claude records drive the Agent SDK, this drives the whole server, and
no backend has been measured at both), the roster the block competes in
(D43 records that narrowing it moves the absolute rate, and pi's roster here
carried four brain tools), or the backend itself. That is #137.

D44 puts the same residue the other way round and names its own failure
condition: if deferral were the whole difference, making the Claude backend
always-load should move it toward pi's rate rather than merely upward. It
moved to 76–77%. That is the prediction failing, and the shortfall is what
#137 is for.

**Which kind, not just whether.** Every measurement before this one scored
whether a block was drawn and never which one, so a model reaching for the
wrong kind scored as a success. Scoring against the kind the brief itself
prescribes — clause by clause from `SHOW_BLOCK_CONTRACT.brief`, with the
project-summary prompt left unscored because the brief prescribes nothing
single for it — gives **44 of 48**, and every miss is the same miss: asked
what is coming up over the next few weeks, pi drew a `timeline` rather than
the `schedule` the brief names for "what is coming", 4 times out of 4. A
kind can be reachable and still be reached for the wrong question, and no
rate measures that.

**What this does not say.** Seven of eight prompts drawing the kind the
brief prescribes is not evidence that the brief's *content* is what did it.
Every pi turn was measured with the brief present, because pi has no
supported way to run without it, so this is a single-arm result and
attributes nothing to the brief in either direction — the description names
all eleven kinds too, and several of these prompts have an obvious kind. A
comment of mine on #157 drew that inference and is retracted there; D44 is
where it was caught. What survives is the part that needs no attribution:
**a wrong kind was drawn reliably, and a call-rate metric would have scored
all four of those turns as successes.**

That clause is worth naming precisely, because it bears on whether the brief's
enumeration earns its tokens now that the tools are always loaded (#157). The
brief says "a `timeline` for what happened when; a `schedule` for what is
coming". The tool's own description already says, at `schedule: what is coming`,
`packages/ui-sdk/src/tool-contracts/blocks.ts:727`, "timeline: what happened
when, oldest first … schedule: what is coming, grouped by day". The model drew
the wrong one of the two 4 times out of 4 **with both surfaces in the prompt
saying nearly the same words**. So for this pair the brief duplicates the
description rather than adding to it, and saying it twice does not fix the miss
— the same lesson D42 recorded when the brief was rewritten twice and still
measured zero. More text is not the lever.

One thing only a per-kind count shows: the `trend` prompt drew 14 blocks
across 8 turns — the prescribed `trend` every time, plus an unprescribed
`bars` companion on most of them. "One or two blocks per answer" is a
description rule being stretched, and a rate cannot see it.

**The classification pass, live.** Thirty-two turns with the pass enabled
against `jev-latest`, 18:29:13Z to 18:44:35Z: **31 `skipped_no_candidates`,
1 `swapped` at 718 ms, zero timeouts, zero errors, zero rate limits, and the
breaker never opened.** The one swap drew a `receipt` from a key-value run
in the trail-signage answer; that corpus predates [the ruling](example-corpus.md).
Latency sits in the 700–800 ms band D42 measured on the Claude side.

The shape of the difference is not the classifier; it is that pi hardly ever
leaves it anything. D42's Claude measurement was eight turns, three swaps,
five with no candidate — 3 of 8 answers carried a candidate. Here **1 of 30
did**, and D43's no-brief arm, where the tool is invisible and the model
types markdown instead, carries one on 62% of turns. **pi draws the block
itself, so the net is cast over an empty deck.**

Put the other way round, so the absence is not the only evidence: sending
every recorded pi answer that *does* carry a candidate through the real
classifier (`--classify`, same client, same 2 s budget) answered both of
them, at 716 ms and 259 ms — one drew a `receipt` at 0.96 confidence, one
cleared nothing and kept its markdown. That is three live calls in total,
counting the swap inside the turn: too few to say the classifier is
*indifferent* to which backend wrote the markdown, enough to say nothing
observed suggests otherwise, and all three inside D42's measured latency
band. There is just almost no pi-authored markdown to ask about.

**Trap, recorded.** The brain the harness points at must live outside any
checkout of this repo. The agent's cwd is the brain, and a brain nested in
the worktree lets the model walk up into it: on the first attempt two pi
answers compared Bun and Node by quoting this repo's own `AGENTS.md`. The
shell is not confined to the brain either — the deployment container is that
boundary (the container privilege record, in brain-hosting-template) and a developer host does not have one —
so the harness records when a tool argument names a path outside the brain
and drops that turn from the rate. Four turns across the two runs were
dropped that way, and **all four were the `trend` prompt** — the one that
sends the model counting notes, so it is the one that goes looking. Three
plainly answered about a different brain (one reported 1,953 files, against
this corpus's 25). The fourth answered from the corpus and was dropped
anyway, because it named a path outside it: the rule is deliberately the
conservative one, since an over-eager exclusion shrinks a printed
denominator while an under-eager one quietly corrupts a rate. It is why the
`trend` row reads 4 of 4 rather than 6 of 6 in both runs.

A Claude-backend control on this harness is still owed and is #137's. Two of
its three blockers now have known fixes: keep the brain outside any
checkout, and point `CLAUDE_CONFIG_DIR` at an empty directory, which stops
the Agent SDK answering about this repository instead of about the brain.
The third is open — in the probe turn no brain MCP tool came up at all,
where pi had four, and a control whose roster is missing them is not
comparable.

_Resolved on 2026-09-25, in "measured: the Claude backend at server level,
beside pi (#137)" below. The brain tools were present but deferred, and the
remaining leak was the CLI's ancestor walk, not the config directory. Two
turns there still ran a `find /` that the escape rule cannot see, and were
excluded._

## 2026-09-22 — the composer follows soft wrap

"`Composer` is net-new work, and it is finished" recorded a trade: height from
a controlled value's newline count, capped at five rows, keeping the component
a pure function of its props at the cost of not growing on soft wrap. The cost
landed on the most common input there is — a paragraph typed into a
phone-width field scrolled inside one visible line (#92) — and the trade is
replaced, keeping the half that mattered.

**What replaced it.** `field-sizing: content` on the textarea, applied only when
there is text to follow. The browser's own line layout, which runs on every
keystroke regardless, is the measurement; the component stays a pure function
of its props with no ref, no measuring and no layout effect, so a keystroke is
still one render of the subtree that re-renders on every keystroke by design.
The newline count stays on `rows` as the floor: a browser without
`field-sizing` (it arrived in Chrome 123, Safari 26.2 and Firefox 152) sizes
from `rows` alone and gets exactly the old behaviour. Where `field-sizing`
applies, `rows` bounds nothing, so the cap has to carry `maxRows` itself: it is
`maxRows` whole lines or the design's 96px, whichever is smaller. That is what
the constant `maxHeight: 96` already produced while `rows` did the bounding —
the default still stops at exactly 96px, a smaller `maxRows` gets that many
whole lines rather than a fraction of 96, and a larger one does not raise the
ceiling. Scaling 96px by `maxRows` instead was tried first and rejected: it
spreads the default's deliberate ~4.90-line shortfall to every other row count,
so a three-row field clipped by a pixel that no shipped behaviour had clipped.

**Alternatives refused.** *Measuring `scrollHeight` in a layout effect:* a
forced synchronous layout per keystroke, and either a `setState` that commits
twice per character or a direct style write that makes the height a thing the
render does not know about. *The stacked-grid replica* (a hidden copy of the
value in the same grid cell): works everywhere, but doubles the text in the
DOM, and its correctness rests on two elements' text metrics never diverging.
Both buy back browsers that will have `field-sizing` before either would ship
its next bug.

**An empty field stays one row.** With no text there is nothing to follow, and
a placeholder longer than the field would otherwise take a second row that the
first character typed took away again. The uncontrolled composer is untouched.

## 2026-09-24 — D46: a shared answer draws its blocks, in a print theme (#46)

**Question.** Sharing an answer as PNG or PDF sent the message's markdown
source to the renderer, so every kit block was missing from the file: a
classified table shared as its raw text, and an explicit `show_block` payload,
which is not in the markdown at all, shared as nothing. What should draw the
shared file?

**Ruling (maintainer, recorded on #46).** Neither the markdown alone, nor a
capture of the live DOM, nor a server that renders React. The browser renders
each block to static HTML with the transcript's own `BlockCard` and embeds it
in the markdown it already sends. `marked` passes raw HTML through, and the
renderer stays scriptless and network-denied. PNG and PDF share that one
document.

- **Order** is `message.parts`: a block sits where the model called
  `show_block`, whenever its payload arrived. Thinking, the tool trace,
  `ask_user` exchanges, and a `show_block` payload that fails the schema are
  left out, as the transcript's answer leaves them out.
- **Print is its own theme**, not the light or the dark one.
  `PRINT_TOKENS` is derived from `LIGHT_TOKENS` by
  `tools/theme/derive-print.ts` under four rules: a white ground, no
  translucent washes, borders that carry the structure (flattened to opaque
  colours a printer keeps), and the light theme's ink. The recommended column
  of a comparison keeps a fill, because it is data. `tests/print-theme.test.ts`
  pins the table, the stylesheet block and each rule.
- **Dependencies run one way**: `ui-kit` → `ui-react` → HTTP → `ui-server` →
  `render-template` → renderer. `ui-kit` owns the palette and `printThemeCss()`.
  `ui-react` composes the document and adds the print `<style>` only when an
  answer has a block. `ui-server` and `render-template` gain nothing and
  know nothing of the kit, which keeps React out of `core`'s `brain render`.
- **A message with no block sends exactly what it sent before**, so the
  common case cannot regress.

**Rejected.** *Capturing the rendered DOM:* the ref covered only the last text
group, the app's Tailwind classes do not exist in the render template, and a
phone-width dark screen is not a page. *Server-side rendering:* it would put
React and the kit into `ui-server`, or into `render-template` and so into
`core`. *Reusing the light theme for print:* its washes and translucent
borders assume a screen, and fade or turn muddy on a grayscale printer.

**One layout change the ruling did not name.** It placed per-format layout in
`render-template`. The PNG width and A4 already live in the renderer, and the
one block-specific rule (`break-inside: avoid` in print) travels in the print
`<style>`. `render-template` is therefore unchanged, and a message without
blocks produces the same document byte for byte.

**Known limits.** The kit's web fonts cannot load in a network-denied
renderer, so shared blocks fall back to the system fonts the rest of the
document uses; embedding the fonts would inline them into every share request.
And several blocks carry a meaning in ink colour alone (a trend delta's good
or bad tone, a table cell's judgment), which a grayscale printer loses: the
tone inks come out as near-equal greys. That is fixed in the components, with
a non-colour cue, not in the palette (#309).

**Proof.** `tests/share-render.test.ts` renders an answer with every block kind
in real Chrome. It asserts that nothing but inline data was requested, that
each block is drawn with a white ground, the print ink, and only print-palette
backgrounds, that the PDF is A4, and that a no-block answer renders to a PNG
byte-identical to the old path. `Blocks/In print` renders every block under
the accessibility gate in both story projects, and four print baselines cover
it in the pinned image.

**App export destinations, 2026-09-30 (#558).** The maintainer selected the
concrete opt-in `linkPolicy: "visible-destinations"` in the shared template.
The app's render route enables it after validating the request and passes the
same option to its renderer for both formats. A bare/full document only opts
out of the shell, never this policy. CLI defaults stay unchanged. The shared
classifier lives in `render-template/links`; the kit re-exports its existing
public imports. Neither the template nor the renderer depends on the kit or
React. The edge table records these two hard leaf dependencies, and existing
build/publish order already puts the template first.

The final HTML is structurally parsed. SVG navigation becomes an inert figure
plus a disclosed ordinary caption link; its drawing is preserved. Declarative
shadow templates are flattened before classification. Embedded documents
(`iframe`, `object`, `embed`) become honest placeholders: Chrome otherwise
includes their independent links in PDF annotations even without JavaScript.
Content-supplied bases, refresh navigation, form targets and SVG href-changing
animations are removed. These rules leave the approved static block vocabulary
and ordinary document styles intact.

Chrome then protects the destination in the final screen/print layout, freezes
motion and checks every destination glyph's geometry and hit-test visibility.
Local clipping/hidden styles are repaired; an obscuring overlay, an unresolved
clipped glyph or a destination beyond the PNG capture cap refuses the export.
Protected declarations follow source shorthand resets. A fresh first layer
prevents source rules from reopening the protection layer, and painted
pseudo-elements participate in hit testing. A document with accepted links
refuses export if its content security policy blocks the protective stylesheet.
The optional renderer lazily loads PDF.js to verify the finished PDF too:
every external annotation must have its own tagged, complete destination on
that physical page at the 9-point floor. Chrome's print scaling and page-size
clipping can differ from live print-media geometry. Author words occupy a
separate paragraph tag; the final monospace code tag owns the disclosure
(older Chrome maps it to `NonStruct`). Body text cannot substitute for it.
The render budget still bounds this work. Scripts remain disabled for this
policy, even if a general-purpose renderer was configured to allow them. The
network and sandbox defaults do not change. Custom app renderer implementations
must honor the option's final-visibility check as well as the HTML transform.

`tests/export-links-runtime.test.ts` inspects real PDF annotations and text,
plus the actual PNG capture's DOM. Its inline image proves the request observer
is wired; no external requests occur. It covers alternate markup, fragments,
mail, long hosts and supplied hiding/clipping CSS at 320/768 pixels. Default
CLI byte preservation and the existing full block print/runtime suites remain
separate checks.

## 2026-09-25 — D47: `show_block`'s schema can lose a tenth through `definitions`, not half, and nothing ships until a keyed run says the API and the model accept it

> **2026-10-08 — Superseded choice.** This entry describes the former flat
> shipped form and its keyless estimates. The #336 measurement and #563
> provider-acceptance decision below select the shared and trimmed form.
> Its old counts remain historical; they do not describe the new default.

**Question.** D44 put the bridge tools in every prompt and priced `show_block`
at 5270 of their 7335 tokens, and its input schema is emitted flat, with no
`$defs` and no `$ref` (`BLOCK_SCHEMA`, `packages/ui-sdk/src/tool-contracts/blocks.ts:698-701`).
#155 asked where those characters go, whether a shared-definition form is
reachable through the path the schema actually takes, and what a reduction
would do to D44's arithmetic. This entry is keyless: no `count_tokens` call and
no live turn was made, so every token figure below is an estimate and says so.

**The instrument.** `bun scripts/attribute-show-block-schema.ts` lists the
tools `createBrainUiMcpServer` registers over an in-memory MCP client — the
serialisation `measure-show-block.ts --tokens` prices — and splits each variant
of the `block` union into three parts that always sum to it: **prose** (every
`description`, measured as the variant's length minus its length with every
description removed), **repeated structure** (the outermost subtrees, with
descriptions removed, that also occur elsewhere in the union and are longer
than a reference to them would be; only schema positions count, so an `enum`
array or a `properties` map never does), and **irreducible** shape, which is
what the other two leave. `tests/attribute-show-block-schema.test.ts` pins the
counting rules against columns worked out by hand.

**How the token figures are estimated, and how far to trust them.** They are
characters times a rate, given as a range. The rate comes from D44's five
counted rows, each set against the characters that tool carried at D44's
commit (`2efd725e`): its description plus its input schema, both as
`JSON.stringify` writes them. D44's count also included the prefixed tool
name (23–35 characters), which the intercept absorbs.

| tool | chars (description + schema) | counted tokens | fitted | residual |
| --- | --- | --- | --- | --- |
| `show_block` | 2117 + 10,653 = 12,770 | 5270 | 5269 | 1 |
| `ask_user` | 684 + 1313 = 1997 | 756 | 778 | −22 |
| `query_activity` | 905 + 525 = 1430 | 552 | 542 | 10 |
| `request_image_mask` | 665 + 371 = 1036 | 383 | 378 | 5 |
| `get_current_location` | 768 + 246 = 1014 | 374 | 369 | 5 |

Least squares gives **tokens = 0.4168 × chars − 54.1**. The slope is the
marginal cost of one more character of tool definition, and that is what a
change to the schema moves, so it is the rate to apply to a *difference* in
characters. It is not a rate to apply to a whole tool on its own: the
intercept is not zero, and schema characters alone at 0.4168 would put
D44's `show_block` at about 4,440, not 5270, because the description is part
of what was counted. Refitting with each row left out in turn moves the slope
between **0.390 and 0.417**. The low end is the fit without `show_block`, the
only large row and the one with most of the leverage. That range is the width
of every token figure in this entry. The fit has limits beyond its five rows:
the API renders a tool in its own format rather than as this JSON, so a
character is only a proxy, and applying an average rate to a specific cut
assumes the characters removed tokenise like the average character of these
five tools. Enum values and English descriptions are the bulk of both, which
is why it is a usable estimate and not a count. The script prints this table
and these limits with every run. A two-rate fit, with prose and structure
priced separately, was tried and dropped: five rows cannot tell the two rates
apart.

**The attribution on `main` today.** The schema is 10,734 characters, 10,610 of
them the union; the tool description the model also reads is another 2,309.
The last column is the prose that restates `SHOW_BLOCK_DESCRIPTION`, classified
by hand from `--prose`. It is 21 descriptions, among them "Three fit a phone;
four only on a wide screen", "Omit when there is no comparison", "Right-align
numbers", the `bars` tone's "class of work" sentence (word for word), the
`steps` variant legend, "Reserved for the one event still happening", "What is
coming, grouped by day", and "pre-formatted" on four value fields.

| variant | chars | prose | repeated structure | irreducible | ≈ tokens | prose that restates the description |
| --- | --- | --- | --- | --- | --- | --- |
| `comparison` | 1704 | 866 | 184 | 654 | 664–711 | 296 |
| `receipt` | 1173 | 625 | 277 | 271 | 457–489 | 100 |
| `contact` | 1108 | 523 | 197 | 388 | 432–462 | 0 |
| `trend` | 991 | 555 | 80 | 356 | 386–413 | 269 |
| `stats` | 983 | 559 | 92 | 332 | 383–410 | 148 |
| `table` | 887 | 242 | 80 | 565 | 346–370 | 37 |
| `schedule` | 838 | 280 | 80 | 478 | 327–350 | 48 |
| `quote` | 761 | 454 | 0 | 307 | 297–317 | 48 |
| `steps` | 753 | 319 | 0 | 434 | 294–314 | 186 |
| `bars` | 747 | 331 | 80 | 336 | 291–312 | 331 |
| `timeline` | 653 | 224 | 80 | 349 | 255–272 | 101 |
| **all 11** | **10,598** | **4978** | **1150** | **4470** | **≈ 4133–4420** | **1564** |

The token column is each variant's characters times the 0.390–0.417 range.
It is the marginal cost of that many characters, not a share of 5270.

Three shapes make up all the repeated structure: the `tone` enum (six sites,
80 characters each), the `valueTone` enum (five sites, 92 each) and the
`{k, v, tone}` fact row `receipt` and `contact` share (two sites, 197 each).
Among the prose, three descriptions repeat verbatim: the `valueTone` doc five
times, the `tone` doc five times and the `icon` doc three times — 1,447
characters, more than a quarter of the union's prose, spent saying the same
thing again.

The filing's figures — 11,452 characters, of which the `oneOf` was 11,319 —
do not reproduce. Listing the tools at D44's own commit (`2efd725e`, Agent SDK
0.3.278) gives 10,653, and so does `z.toJSONSchema` with `io: "input"` at every
earlier revision of `blocks.ts`; `io: "output"` gives 11,407. The calibration
above uses the figure that commit's code produces.

**Is `$defs` / `$ref` reachable? Yes, by one route.** The Agent SDK bundles its
own MCP server, whose `tools/list` handler converts a tool's Zod shape with
`toJSONSchema(schema, { target: "draft-7", io: "input" })` and nothing else.
So Zod's `reused: "ref"` — the option that would share every repeated schema
automatically — cannot be passed; it was measured anyway by calling Zod
directly, and it makes the schema **larger**, 12,929 characters against
10,734 on the same tree (12,848 against 10,653 at `2efd725e`), because it
references every reused instance down to the bare strings and wraps each
reference in `allOf`. The route that works is Zod's registry: a schema that
carries `.meta({ id })` in `globalThis.__zod_globalRegistry` is always
extracted, whatever `reused` says, and the SDK's bundled Zod reads the same
global registry as the tree's. Given ids to three shapes — `valueTone` and
`tone` each with their description folded in, and `icon` —

```ts
const valueToneField = valueTone.describe(valueToneDoc).meta({ id: "valueTone" });
const toneField = tone.describe(toneDoc).meta({ id: "tone" });
// ...each `valueTone.optional().describe(valueToneDoc)` becomes `valueToneField.optional()`,
// each `tone.optional().describe(toneDoc)` becomes `toneField.optional()`,
// and `icon` gains `.meta({ id: "icon" })`.
```

— the schema the server registers goes from 10,734 characters to **9,493**,
with a three-entry `definitions` table and thirteen
`{"allOf":[{"$ref":"#/definitions/<id>"}]}` sites. An id is metadata, not a
check, so nothing a variant accepts should move; #336 asks for the round-trip
test that proves it. The script checks this independently of Zod. It
applies the same sharing as a transform of the listed JSON, checks that
dereferencing the result gives back the original, and gets the same three
shapes at the same thirteen sites, 1,267 characters shorter. The 26
characters between the two are serialisation detail (the ids and key order),
not a different reduction. Giving the enums ids without folding their
descriptions in saves only 255, because the description then stays at every
site.

**Would the API accept it? Documented, not demonstrated.** The platform docs'
JSON Schema limits for strict tool use list `$ref` and `definitions` as
supported, and a non-strict tool is held to less than that. The Claude Code
binary the SDK ships (0.3.280) marks a tool strict only when the tool says
`strict: true`, which `show_block` does not, and nothing found in its
tool-definition path rewrites references. One trap is worth recording: the
same limits list "`allOf` with `$ref`" as unsupported under strict tool use,
and that is precisely the form Zod's draft-7 output takes. It does not apply
today; it would the day anyone makes `show_block` strict. The pi backend is a
second serialisation: it converts through `toolInputJsonSchema`
(`toolInputJsonSchema`, `packages/ui-sdk/src/tool-contracts/contract.ts:101-109`),
which uses Zod's default
draft-2020-12 target, so the same ids would put `$defs` into every schema pi
sends to its providers. And registry ids are process-global, so an id any
other schema in the process also uses collides.

**What it would do to D44: an illustration, not a bound.** The 1,241
characters come to ≈ 480–520 tokens, about a tenth of `show_block`'s 5270
and 7% of the 7335. That is far from the half at which #155 thought D44's
arithmetic might change sign. For scale, D44's always-loaded brief arm
averaged 26,694 input tokens per round-trip, so the cut is about 2% of that
average. That comparison holds only if everything else about a turn stays
the same: the same round-trips, the same output, and the same mix of cached
and uncached input. None of that is established. A turn's bill weights cache
reads, cache writes, uncached input and output differently. D44 kept its
token and dollar populations apart for exactly that reason. And a schema that
changes what the model sends can change how many round-trips a turn takes,
which could move the bill by more than 2% in either direction. So this entry
draws no conclusion about D44's 6% beyond this: a cut of this size is not
the kind D44's reasoning turned on. Dropping the 1,564 characters of
restated prose would add ≈ 610–650 tokens on the same footing. **Whether
either one moves the bill is #336's to measure.**

**Decision. Nothing ships from #155.** The reduction is real and reachable,
but a keyless spike cannot show that the API accepts the `definitions` form
on both backends, and neither the shared definitions nor the missing prose can
be shown not to move the call rate or the rate of calls that parse — the only
things D43 and D44 measured that the reader sees. A change to what the model
reads on every turn goes out with its A/B, as D44's did. #336 holds the
keyed work: price the patch with `--tokens`, send it once per backend, and A/B
it in the loaded configuration. D44's 5270 stands until that entry supersedes
it.

**Rejected.** *Zod's `reused: "ref"`:* unreachable through the SDK's path, and
a fifth larger when forced. *Sharing the `{k, v, tone}` fact row:* 197 characters
at two sites, where `receipt`'s copy carries two descriptions `contact`'s
does not, so there is nothing identical left to share once the descriptions
are counted. *Moving `blocks.ts` to plain JSON Schema to escape Zod's `allOf`
wrapper:* the SDK's `tool()` takes a Zod shape, and one source of truth for the
schema, the parser and the renderer's types is worth more than eleven
characters per reference.

## 2026-10-07 — measured: Claude accepts all three schema forms; the shared and trimmed form saves 1,146 counted tokens (#336)

**Question.** D47 identified two schema reductions but had no live provider or
behavior evidence. This measurement holds the eighteen current variants and
accepted inputs constant and compares `flat`, `shared`, and `shared-trimmed`
on **`claude-sonnet-5-5`**. It measures the Claude half; the cross-backend
shipping decision remains #563's.

**Counted definitions.** The Agent SDK's actual MCP listing, including the same
4,918-character tool description in every arm, was counted by `count_tokens`
under `CLAUDE_CODE_OAUTH_TOKEN`. The tool-search-plus-anchor floor is **616**
tokens. The flat arm is byte-identical to the production listing. The shared
forms contain three definitions and sixteen reference sites; the trimmed
form removes the same 23 descriptions pinned by the parser/listing tests.

| form | input-schema JSON characters | loaded tokens | change from flat |
| --- | ---: | ---: | ---: |
| flat | 16,702 | 8,723 | 0 |
| shared | 15,136 | 8,157 | −566 (6.5%) |
| shared-trimmed | 13,344 | 7,577 | −1,146 (13.1%) |

The full block brief costs 254 counted tokens, nine lines and 705 characters.
These are the endpoint's counts of the frozen definitions, not a claim that
every live round-trip loses exactly that many input tokens.

**Method and isolation.** Nine frozen prompts—compare-short, compare-long,
trend, contact, recommend, table, steps, quote and bars—ran three times per
form: **81 fresh turns, 27 per arm, no exclusions**. Every arm loads the bridge
server and block brief. Each form occupies each order position once across
the three repetitions. Concurrency is two; each turn has the same fourteen
model-turn limit, 180-second deadline and SDK `maxBudgetUsd: 1` threshold.
None censored a turn. The threshold is checked after generation and is not a
hard billing cap.

Bun 1.3.14, Agent SDK 0.3.283 and Claude Code 2.1.283 were used. Every raw init
reported model `claude-sonnet-5-5` and `apiKeySource: none`. The fictional
Odysseus corpus was staged outside a home directory and checkout; HOME and
config were empty, account credential files were never copied, automatic
memory was disabled, and no other subscription measurement overlapped.
The same execution hook bounded Read/Glob/Grep to the staged fixture and
denied delegation and other tools in every arm (`optionsFor`,
`scripts/measure-show-block.ts:398-466`). This permission restriction and the
one-tool MCP server remain measurement divergences from production. The
actual installed CLI denied a controlled outside Read and admitted an inside
Read under bypassPermissions; removing its hook exposed the sentinel and
failed the expected assertion. All **332** live hook verdicts were allowed
fixture reads/searches or block calls; none named an outside target.

Different-family review covered the frozen prompts, schemas, counters and
execution guard before inference. Historical corpus model authorship was
unknown, so a complementary Sonnet 5.5 review also examined all textual
fixture files and canonical facts; binary fixtures were digest-only. It
returned APPROVED. Native stdout capture preserves split UTF-8, final JSON
without a newline and error-result receipts even when a consumer throws.

**Observed behavior.** A call-rate numerator requires at least one parsed
block in a completed turn. Parse rate counts every attempted block call,
including a rejected call followed by a valid retry.

| form | completed / attempted | turns with parsed block | call rate | parsed / attempted calls | parse rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| flat | 27 / 27 | 21 | 77.8% | 22 / 22 | 100% |
| shared | 27 / 27 | 21 | 77.8% | 23 / 24 | 95.8% |
| shared-trimmed | 27 / 27 | 21 | 77.8% | 22 / 22 | 100% |

The shared form's compare-long turn in repetition two first sent `block` as a
string, which failed the object parser, then sent a valid block. Every contact
and steps prompt produced no block in every arm; the other seven prompts
produced one on every repetition. Completed shared-form turns demonstrate
provider acceptance of both definitions-based request shapes. Equal observed
call rates in this small repeated prompt set do not establish behavioral
equivalence or bound regressions on other prompts.

**Usage and money.** Independently priced API equivalents sum to **$4.0214248**:
flat $1.3931550, shared $1.3425880, trimmed $1.2856818. The complementary review
adds $0.079636. These use actual modelUsage tokens and cache-write TTL counts,
not SDK fallback dollar estimates (`priceSonnet55Usage`,
`scripts/measure-sonnet55-cost.ts:28-51`), against the
[official Sonnet 5.5 rates](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
as published on 2026-10-07, when the table gave $0.20 per million cache reads;
the current rate is $0.10 (#1239). These totals are unchanged.
All scored cache writes had known TTLs. Cache state, output length and retries
also move these totals; they are diagnostics, not an isolated estimate of the
schema reduction's dollar effect or a subscription billing receipt.

All 86 captured rate-limit events reported `isUsingOverage: false`; no
additional billed overage was observed. The
[maintainer's caps](https://github.com/schlessera/brain-kit/issues/838#issuecomment-6038531493)
apply to actual additional charges. The counter is
[free to use](https://platform.claude.com/docs/en/build-with-claude/token-counting).
Historical Sonnet 5 controls remain excluded: 42 completed and two
interrupted attempts, $3.0837498 known-plus-recovered partial SDK estimates,
two missing tails and an unknown aggregate. No final provider bill is asserted
for those interruptions. Unknown SDK price provenance is tracked in #1206;
missing error-result accounting is #1191.

**Evidence and consequence.** The [sanitized per-turn artifact](design-kit-schema-forms-2026-10-07.json)
retains all 81 cells, token columns, verified prices, rate flags, isolation
verdicts and frozen source/schema/corpus identities. Claude accepted both
reductions, and the counted saving is real. This result does not switch the
shipped flat form; #563 owns pi's acceptance and the shipping choice.

## 2026-10-08 — D47 superseded: ship shared definitions and trimmed prose after both serializers accept them (#563)

**Decision.** Ship `shared-trimmed`: define `tone`, `valueTone` and `icon` once,
and remove the 23 field descriptions that restate the tool description. Tool
names, all eighteen variants, accepted inputs, validation and handler output
remain unchanged. The historical `flat`, `shared` and `shared-trimmed` arms now
have explicit options independent of the shipped default. Production-factory
checks cover Claude's actual MCP listing and Pi's actual bridge parameters;
removing the icon registry id fails each backend's named definitions assertion.
The accepted/refused round trips still compare all three forms.

**Evidence from both serializers.** #336's 81 fresh Sonnet 5.5 turns completed
27 per form; 21/27 turns in each form contained a parsed block. Its frozen
counted MCP listing was 8,723 / 8,157 / 7,577 tokens for flat / shared / trimmed,
a 1,146-token (13.1%) reduction for the selected form. One shared-form block
was rejected before a valid retry; trimmed parsed 22/22 attempts. These are
that measurement's model, listing, counter and SDK/CLI versions, described
above, not a current-runtime recount or a behavioral-equivalence guarantee.
D44's historical 5,270 and D47's keyless estimates remain qualified by their
original listing/version; the measured #336 table supersedes them for this
frozen listing. No new runtime or model default is selected here.

Pi separately sent the actual non-strict draft-2020-12 `$defs`/`$ref` parameters
through installed `@earendil-works/pi-coding-agent` 0.99.2 to `openai-codex` /
`gpt-6.1-sol`, using Bun 1.4.2 and the ruled existing native ChatGPT login in a
read-only memory adapter. One natural, reviewed note-approaches prompt was
used per form, with the same reviewed 31-file fictional corpus. No login,
refresh, credential-file copy, alternate key, paid fallback or automatic model
retry was performed. Empty owned homes/settings, fixture-only tool execution
and read-only source/runtime mounts bounded private-data access; the live
network namespace was shared and the selected fetch route was guarded.
Actual isolated-network server/parser/handler controls preceded inference.

| Pi form | logical turn completed | parsed comparison calls | unique physical requests | strict transport guard |
| --- | --- | ---: | ---: | --- |
| flat | yes, after local prefix rehydration | 1 | 2 | failed; historical natural upstream EOF unknown |
| shared | yes | 1 | 2 | passed, natural upstream EOF observed |
| shared-trimmed | yes | 1 | 2 | passed, natural upstream EOF observed |

**Retained failures and continuation.** The original flat request returned a
completed exact-model comparison but its observer rejected its required
media-type condition before the handler received it; the exact original
content-type was not saved and remains unknown. Its failed server session remains
unsuccessful. The preserved response was `response.text()` saved as UTF-8;
replay preserved those exact file bytes, not independently recorded HTTP-wire
response bytes. An independently reviewed local replay rehydrated that one
actual response into the real Pi parser and handler, preserving original
prompt, instructions, tools, model, call identity, arguments and handler result.
The reconstructed server/cache key differed; this was continuation of the same
logical context, not the same server session or unchanged request wire.

One native flat continuation completed, but the old observer mistook Pi's
normal consumer cancellation after `response.completed` for upstream EOF,
then failed closing an already closed controller. The completed provider/model
and parsed-handler evidence is valid; its strict transport guard remains
failed and natural upstream EOF remains unknown. After real delayed-EOF and
preterminal-cancellation controls and mutations, an ordered observer drained
independently to natural EOF before any next request or final admission.
Only the two originally remaining shared forms were then dispatched; flat
was never inferred again. Both fresh shared turns passed all request/model,
handler, usage, EOF and lifecycle guards and exited zero.

**Accounting and limits.** Six unique physical requests are retained, including
both historical flat requests exactly once: 66,266 raw input, 1,084 output and
21,248 cache-read tokens. Physical usage reconciles with each logical SDK
aggregate. Each form stayed below five requests and the total below fifteen.
No included-only limit or credit-decrease stop was observed. Actual additional
charges and invoices remain unknown; SDK dollar fields are diagnostics, not
bills. Account-identity equality across the historical stopped boundary cannot
be proved by the saved auth-selector booleans; no fingerprint is invented.
Account/quota/credit details and raw opaque headers stay in protected receipts.

This is provider request/parsed-handler acceptance for the named OpenAI route,
not a Pi call-rate, quality, cache or cost-saving experiment. Other Pi providers
were not tested. The equal first-request input count for flat/shared and the
smaller trimmed count are individual observations, not an isolated token
counter or a general saving. The small Claude sample also does not establish
equivalence on other prompts. These limits qualify the selected representation;
they do not change any accepted input or infer a new API/runtime/model adoption.

The [sanitized six-request artifact](../../scripts/measurements/pi-schema-2026-10-08/results.json)
and [executed-input hashes](../../scripts/measurements/pi-schema-2026-10-08/executed-inputs.json)
bind the exact remaining-arms admission `a46ca0ba…`, historical `3d58bf7c…`
and original prefix. They retain all failures, raw usage, schemas and accepted
handler evidence without account identities, credit balances or quota details.
Published current instrumentation is parameterized and now preserves historical
arms; literal executed source/runtime and complete private receipts remain
bound to the recorded protected manifests. No further inference was made.

## 2026-09-25 — measured: the Claude backend at server level, beside pi (#137)

**Question.** pi drew a block on 52 of 60 turns (87%, "2026-09-22 — measured: pi draws the block" above). The
Claude backend drew one on 76–77% in D43 and D44, and that residue had three
possible explanations: the layer, the tool roster, or the backend. None of the
three had been measured. D43 and D44 drive the Agent SDK directly. pi was
measured through the whole server. So no backend had been measured at both
layers, and the Claude arm had never run where its brain tools could appear.

**Method.** `scripts/measure-show-block-server.ts --backend claude --model
claude-sonnet-5`, at pi's counts: prompts 0–3 at six reps and 4–7 at two, run
twice. That is 64 turns on 2026-09-25, from 01:45:23Z (the first measured
turn's stream) to 02:12:48Z. It is the shipping configuration, with the bridge
server always loaded (D44) and the brief in the prompt. Claude Code 2.1.280 ran
under `@anthropic-ai/claude-agent-sdk` 0.3.280. The brain was a copy of
`packages/core/fixtures/corpus/`. It was not a git repository and was indexed
with `brain index` before the first turn. D43's counting rules carry over
unchanged. **Every one of the 64 turns completed, and 2 are excluded for
leaving the brain (below), so 62 are counted.**

The environment presences the harness recorded, identical on all four run
files: `CLAUDE_CODE_OAUTH_TOKEN` set. `TYPESAFE_API_KEY`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_PATH` and `PI_CODING_AGENT_DIR` were unset.
So these turns billed the subscription, where pi's billed an API key. The
classification pass was off throughout. None of that can move what the model
does during a turn.

**Isolation, and what it took.** #50 abandoned this control twice. Three smoke
turns found three more leaks, each shown in the CLI's own session transcript
and each closed before the measured runs:

- **The brain has to live outside the operator's home directory, not only
  outside a checkout.** `settingSources: ["project"]`,
  `packages/ui-backend-claude/src/sdk-options.ts:145`, makes the CLI walk up
  from the cwd, and at every ancestor it reads `.claude/CLAUDE.md`,
  `.claude/skills/` and `.claude/agents/`. A brain anywhere under a home
  directory therefore loads `~/.claude/CLAUDE.md` as *project* instructions,
  together with that user's skills and agents. An empty `CLAUDE_CONFIG_DIR`
  does not stop this, because the walk never consults it. This is the leak
  #50 put down to the config directory. The brain ran from a path under
  `/tmp` with no `.claude` ancestor.
- **A copied login is not a deployment's credential.** With a copied
  `.credentials.json` in the empty config directory, the CLI fetched the
  account profile. It then put the account's email address into the context,
  and the model quoted it back when asked whose brain this was. It also
  connected the account's claude.ai connectors, so mail, calendar and drive
  tools joined the deferred roster. Passing the same subscription's access
  token as `CLAUDE_CODE_OAUTH_TOKEN`, the variable a deployment sets, removed
  both. `apiKeySource` was `none` on every turn, and the server's own
  subscription gate admitted each one. **Deviation, recorded:** this is a
  login token passed through the variable meant for a `claude setup-token`
  token, not a setup token itself.
- **Auto-memory reads outside the brain.** The CLI's memory prompt sent the
  model to read its memory directory under `CLAUDE_CONFIG_DIR`, and the
  escape rule correctly dropped that turn. **Deviation, recorded:** the brain
  copy's own `.claude/settings.json` sets `autoMemoryEnabled: false`. The
  same file sets `enableAllProjectMcpServers: true` for the brain's
  `.mcp.json`. Both are brain-repo settings the backend already loads, not
  changes to the backend. pi has no memory feature, so this narrows a
  difference rather than adding one.

**Two turns left the brain anyway, and the harness did not see it.** Run 1's
fifth `trend` turn and run 2's fourth each looked for git history. Both ran
`find / -maxdepth 3 -iname "*.git" -type d` and got back repositories
elsewhere on the host. The saved `escapedBrain` flag is `false` on both,
because the rule (`export function escapesBrain`,
`scripts/measure-show-block-server.ts:280`) looked only for `~/` and `/home/`
paths when these turns ran. A bare `/` never matched that pattern. This brain
lived under `/tmp`, so a path elsewhere outside `/home` would not have matched
either. #360 closed the gap. So the
audit here reads every path-like token handed to a non-block tool — a
bare `/`, `~` and `..` included — out of the CLI's own transcripts. It finds
exactly these two turns. Both are **excluded**, under the rule the harness
states: a turn whose shell left the brain is not a measurement of this brain.
Both drew a `trend` block, so the exclusion lowers the Claude rate rather than
flattering it. `trend` is also the prompt that cost pi its four excluded
turns.

> **2026-09-30 — Corpus ruling.** The former corpus in this measurement is historical.
> [One Odysseus world](example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

Apart from those two, an audit of all 64 transcripts found no tool argument
naming a path outside the brain, no instruction file, no user skill or agent,
and no account email. Skills and agents were only the CLI's built-ins. Every
contact answer named Alex Example, and every schedule answer reasoned about
the corpus's own dates. The per-turn roster was read from each turn's
stream-json `init` message. The CLI was launched through
`BRAIN_UI_EXEC_WRAPPER`, and the wrapper copied its stdout to a file and
changed nothing else. The roster was then joined to the CLI's session
transcript by session id.

**The roster each turn saw**, identical on all 62 counted turns. `init` lists
34 tool names, but that list is an inventory. The session transcript's
`deferred_tools_delta` announces 16 of those names by name only, so they are
behind tool search rather than in the prompt as schemas.

| | Claude backend (this run) | pi (#50) |
| --- | --- | --- |
| in the prompt as schemas | 13 CLI tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent` (`Task` in `init.tools`), `Skill`, `ToolSearch`, `ListAgents`, `ReportFindings`, `ScheduleWakeup`, `Workflow`) plus the five bridge tools, `show_block` among them: 18 | pi's curated surface: `read_file`, `grep`, `bash`, the file writers, the eight `brain_*` tools, and the bridge tools with `show_block` |
| behind tool search, by name only | **all eight `mcp__brain__*` tools**, plus 16 CLI tools (`WebFetch`, `WebSearch`, `NotebookEdit`, the cron, plan-mode, worktree and messaging tools and others) | nothing; pi cannot defer a registered tool |
| called, across the counted turns | `Bash` 103, `Read` 72, `show_block` 40, `Grep` 28, `Glob` 5, `ToolSearch` 5, `brain_search` 3, `brain_list` 3 | `bash`, `show_block`, `brain_read`, `grep`, `brain_search`, `read_file`, `brain_list`, `brain_graph` |

**The brain MCP tools are in the Claude roster, but deferred.** The brain's
`.mcp.json` registers a stdio server without `alwaysLoad`, so the CLI lists its
eight tools by name only, behind `ToolSearch`. This is the configuration every
brain made from the template ships, not a harness artefact. The model loaded
them in 5 of 62 turns and called one in 3. It read the brain with `Bash` and
`Read` instead. D43 found the same mechanism for `show_block`. Here it applies
to the tools that read the brain.

**The rate, on one axis.** Each cell counts turns that drew at least one
accepted block. Right kind is scored against the kind the brief prescribes.
The excluded turns are out of every cell.

| prompt | expected kind | Claude, run 1 | Claude, run 2 | Claude, pooled | pi, pooled |
| --- | --- | --- | --- | --- | --- |
| `compare-short` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 |
| `compare-long` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 |
| `trend` | `trend` | 5/5 | 5/5 | **10/10**, right 10 | 8/8, right 8 |
| `contact` | `contact` | 0/6 | 0/6 | **0/12** | 5/12, right 5 |
| `steps` | `steps` | 2/2 | 1/2 | **3/4**, right 3 | 4/4, right 4 |
| `schedule` | `schedule` | 2/2 | 0/2 | **2/4**, right 0 (`timeline` ×2) | 4/4, right 0 (`timeline` ×4) |
| `quote` | `quote` | 0/2 | 0/2 | **0/4** | 3/4, right 3 |
| project summary | — | 0/2 | 1/2 | **1/4** (`receipt`) | 4/4 |
| overall | | 21/31 | 19/31 | **40/62 (65%)** | **52/60 (87%)** |

Right kind is 37 of 39 scorable turns on Claude and 44 of 48 on pi. Both
backends make the same kind error: they draw `timeline` where the brief
prescribes `schedule`. Neither backend typed a markdown table on any turn,
and the handler rejected no Claude call. pi counted eight `trend` turns and
Claude ten, and Claude drew on every one. With `trend` held at pi's eight,
Claude reads 38/60 (63%).

**The gap is wider than it looked, and it is not a flat rate.** Measured at
the same layer on the same prompts, it is 87% against 65%, not 76–77%. The
whole gap sits in five prompts, and all five are answered by reading the
brain: `contact`, `quote`, the project summary, `steps` and `schedule`. On the
three prompts where both backends draw every time, they match at 34 of 34
against 32 of 32. On `contact` and `quote` the Claude backend drew nothing in
16 turns. It typed the answer instead, with the quote as a markdown
blockquote all four times, which is the classification pass's candidate
rather than the tool's.

**The three candidates.** None is ruled out.

1. **The layer is still open, though what could be compared looks the
   same.** The SDK harness and this one share three prompts verbatim:
   `compare-short`, `compare-long` and `contact`. With the tools loaded, the
   SDK harness drew on 6/6, 6/6 and 1/6 of them (D43's per-prompt table, both
   arms), and #148 reports `contact` at 0/3 in both of D44's arms. This run
   drew on 12/12, 12/12 and 0/12. The pattern on those three is similar at
   both layers. That does not rule out a layer effect on the prompts the two
   harnesses do not share. `trend`, `steps` and `quote` are worded
   differently, and `schedule` and the summary have no SDK-level counterpart.
   Most of the gap to pi sits in exactly those prompts. So the 76–77% against
   65% difference is at least partly prompt mix, and this run cannot say it
   is only that.
2. **The roster is still open, and it is the leading suspect.** On the
   prompts where the backends diverge, they differ in exactly the way that
   could matter. On pi the brain tools are in the prompt and get called. On
   the Claude backend they are deferred and almost never loaded. The two
   prompt-level rosters also differ in size and composition — 18 schemas here,
   pi's curated set there. This run cannot separate the roster from candidate
   3, because the roster and the backend changed together.
3. **The backend itself is still open** for the same reason.

The next measurement changes one roster difference on the brain side:
`alwaysLoad: true` on the brain's own stdio server in `.mcp.json`, which puts
the eight `brain_*` tools in the Claude prompt the way pi has them. The
server-level harness can run it unchanged, and it is #358. It tests whether
eager brain tools close the gap. It does not make the two rosters equal: the
13 CLI tools and pi's curated set still differ. A behind-tool-search
`show_block` cell was not needed, because nothing in the always-loaded result
turned on it.

**What this does not say.** Sixteen turns at two reps per prompt on prompts
4–7 are thin. The `steps`, `schedule` and summary cells can move by a turn in
either direction on a re-run, as `schedule`'s 2/2 against 0/2 already shows.
The `contact` and `quote` cells are the firm ones: 0 of 16 on Claude against 8
of 16 on pi. `contact` as its own question belongs to #119. The two backends
also billed differently, the subscription here and an API key on pi. No
mechanism is known by which billing reaches what the model decides, but the
two runs were not identical in that respect.

## 2026-09-25 — measured: eager brain tools change how the Claude backend reads the brain; no observed gain on `contact` or `quote` (#358)

**Question.** The entry above left the tool roster as the leading suspect for
the gap to pi, which sits in the prompts answered by reading the brain. On pi
the eight `brain_*` tools are in the prompt. On the Claude backend they come
from the brain's `.mcp.json` as a stdio server without `alwaysLoad`, so they
wait behind `ToolSearch`. This run changes that one difference and nothing
else: does the rate on the brain-reading prompts move when the brain tools
are in the Claude prompt?

**Method.** The same harness, model, prompts and counts as #137:
`scripts/measure-show-block-server.ts --backend claude --model
claude-sonnet-5`, prompts 0–3 at six reps and 4–7 at two, run twice. That is
64 turns on 2026-09-25, from 04:51:00Z (the first measured turn's stream) to
05:15:43Z, on Claude Code 2.1.280 under `@anthropic-ai/claude-agent-sdk`
0.3.280. The environment is #137's, rebuilt rather than reused: a fresh copy
of `packages/core/fixtures/corpus/` under `/tmp`, outside any home directory
and checkout, with no `.claude` ancestor and no git repository, indexed
before the first turn. `HOME` and `CLAUDE_CONFIG_DIR` were empty, the
subscription's access token was passed as `CLAUDE_CODE_OAUTH_TOKEN`, and
the brain copy's `.claude/settings.json` set `autoMemoryEnabled: false` and
`enableAllProjectMcpServers: true`. The environment presences on all four run
files were `CLAUDE_CODE_OAUTH_TOKEN` alone, and `apiKeySource` was `none` on
every turn. **The one difference:** the brain's `.mcp.json` entry carried
`"alwaysLoad": true`. One smoke turn (`contact`) confirmed the roster and the
isolation before the measured runs. **All 64 turns completed. 3 are excluded
for leaving the brain (below), so 61 are counted.**

**The roster each turn saw**, identical on all 64 turns and read the way #137
read it: the `init` inventory minus the names the session transcript's
`deferred_tools_delta` announced.

| | Claude backend, eager brain tools (this run) | Claude backend, shipping (#137) |
| --- | --- | --- |
| in the prompt as schemas | the same 13 CLI tools and five bridge tools, **plus all eight `mcp__brain__*` tools**: 26 | 13 CLI tools and five bridge tools: 18 |
| behind tool search, by name only | 16 CLI tools, the same 16 as #137 | the same 16 CLI tools plus all eight `mcp__brain__*` tools |
| called, across the counted turns | `brain_read` 61, `show_block` 43, `Bash` 35, `brain_list` 26, `brain_search` 25, `brain_context` 6, `Skill` 1 | `Bash` 103, `Read` 72, `show_block` 40, `Grep` 28, `Glob` 5, `ToolSearch` 5, `brain_search` 3, `brain_list` 3 |

**The change took.** No turn called `ToolSearch`, `Read`, `Grep` or `Glob`.
33 of the 61 counted turns called a brain tool, against 3 in #137, and every
one of the 28 turns on prompts 3–7 read the brain through the brain tools
alone. `Bash` survived only on `trend`, where the model counted files by
creation date. The only skill loaded was the CLI's built-in `dataviz`, once,
on a `trend` turn.

> **2026-09-30 — Corpus ruling.** The former corpus in this measurement is historical.
> [One Odysseus world](example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

**Three turns left the brain.** All three are `trend` turns in run 1. One ran
`find / -maxdepth 3 -iname "brain"`, and two listed the directory that holds
the brain copy. The harness's escape rule, conservative since #360, flagged
all three itself. The transcript audit read every path-like token handed to a
non-block tool, a bare `/`, `~` and `..` included, and found the same three
and no others. All three are **excluded**. Two of them drew a `trend` block
and one did not, so the exclusion moves the overall rate from 44/64 (68.75%)
to 42/61 (68.85%). Apart from those, the audit found no
instruction file, no user skill or agent, and no account email. Skills and
agents were the CLI's built-ins, the same list #137 saw. Every `contact`
answer named Alex Example.

**The rate, on one axis**, beside #137's Claude run and pi's run. Each cell
counts turns that drew at least one accepted block. The excluded turns are
out of every cell.

| prompt | expected kind | eager, run 1 | eager, run 2 | eager, pooled | Claude #137, pooled | pi, pooled |
| --- | --- | --- | --- | --- | --- | --- |
| `compare-short` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 | 12/12, right 12 |
| `compare-long` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 | 12/12, right 12 |
| `trend` | `trend` | 3/3 | 6/6 | **9/9**, right 8 (`timeline` ×1; one turn drew `bars` after its `trend`) | 10/10, right 10 | 8/8, right 8 |
| `contact` | `contact` | 0/6 | 0/6 | **0/12** | 0/12 | 5/12, right 5 |
| `steps` | `steps` | 2/2 | 2/2 | **4/4**, right 4 | 3/4, right 3 | 4/4, right 4 |
| `schedule` | `schedule` | 1/2 | 1/2 | **2/4**, right 0 (`timeline`, `receipt`) | 2/4, right 0 (`timeline` ×2) | 4/4, right 0 (`timeline` ×4) |
| `quote` | `quote` | 0/2 | 0/2 | **0/4** | 0/4 | 3/4, right 3 |
| project summary | — | 1/2 | 2/2 | **3/4** (`receipt`) | 1/4 (`receipt`) | 4/4 |
| overall | | 19/29 | 23/32 | **42/61 (69%)** | **40/62 (65%)** | **52/60 (87%)** |

Right kind is 36 of 39 scorable turns, against 37 of 39 in #137. The handler
rejected no call, and no turn typed a markdown table. On `quote` the model
typed the sentence as a markdown blockquote all four times, as it did in #137.

**The effect, with a number.** Over the five prompts answered by reading the
brain (`contact`, `steps`, `schedule`, `quote` and the summary), eager brain
tools drew on **9 of 28 turns, against 6 of 28 with the tools deferred**. pi
drew on 20 of 28. The whole move is three turns in the two-rep cells, the
summary and `steps`. At four turns a cell, 1/4 to 3/4 is too few turns to
call either an effect or noise. On `contact` and `quote` there was **no
observed improvement: 0 of 16 with eager brain tools, 0 of 16 deferred, and
8 of 16 on pi**. The overall rate went from 65% to 69%, and it is still 18
points short of pi's 87%.

**What that means for the roster candidate.** Deferral of the brain tools
explains *how* the Claude backend read the brain in #137. It went through
`Bash` and `Read` because the brain tools were behind tool search, and with
them in the prompt it reads through them, as pi does. It does not explain
*whether* it draws. On `contact` and `quote` the model now reads the brain
the way pi does and still typed the answer on every turn measured. So
deferral does not account for the size of pi's lead on those two cells (8 of
16 against 0 of 16). These counts cannot rule out a smaller effect: a true
draw rate of 10% still gives 0 of 4 about two times in three. It does not
rule out the roster either. The Claude prompt still carries
the 13 CLI tools, and pi carries its curated set, so the two rosters still
differ in size and composition. The layer and the backend are also still
open. Nothing here separates them from what is left of the roster.

**What this does not say.** It does not say what `brain setup` or the
template should write into `.mcp.json`. That is a separate decision this run
informs, not makes. The rate is one input to it. The prompt was 8 schemas
larger, and on prompts 3–7 the model stopped reading the brain through a
shell. Prompts 4–7 are still two reps a run, so the summary's 1/4 to 3/4
and `steps`' 3/4 to 4/4 are open in both directions, and so is an effect on
`contact` and `quote` smaller than these counts can see.

## 2026-09-28 — D48: a model-authored link shows its destination, and Brain never opens it (#43)

**Ruled 2026-09-28, before implementation.** This entry records the ruling
and its reasons. The PR that builds it appends what building it found, the
way D41's "Built" note does, and supersedes a point here if the code
disagrees.

**Question.** `LinkPreviewCard` is in the kit and D41 §2 left it out of
`show_block`, because its props carried no URL (`LinkPreviewCardProps`,
`packages/ui-kit/src/blocks/LinkPreviewCard.tsx:67-97`, where they now do). Giving it one is not
just a missing prop. The model chooses the URL, the title and the
description, and it may have read untrusted content before choosing them. A
card like that, drawn inside an answer the user trusts, is a phishing shape:
a model-chosen title over a destination the user cannot see.

**Ruling (maintainer, recorded on #43).** A `link` block that shows where it
goes and fetches nothing.

1. **The boundary.** Only absolute `http:`/`https:` URLs are accepted.
   Embedded credentials and every other scheme are refused. The displayed
   host comes from the same validated URL the anchor navigates to, never from
   a model-supplied field. The host is visible before any click, and the full
   URL can be inspected. Title and description are shown as the model's
   words, not as page metadata. No title, favicon, image or destination
   content is fetched, and navigation happens only on an explicit user
   activation of the Open anchor.
2. **One classifier, `classifyLink`, pure and in the kit.** It lives in
   ui-kit behind a React-free subpath export, `@schlessera/brain-ui-kit/links`.
   It does no I/O, no DNS and no `window`. Raw-string checks run before the
   WHATWG parser, so a tab or a bidi control the parser would silently strip is
   refused rather than cleaned. Its refusal reasons are `unparseable`,
   `relative`, `scheme`, `credentials`, `mixed-script`, `hidden-characters`
   and `too-long`.
3. **The kit takes `url` and derives everything itself.** `LinkPreviewCard`
   gains `url`, `description`, `expanded`, `onExpandedChange` and `onCopy`.
   With `url` present, it calls `classifyLink` and draws either the
   destination card or the Link withheld card, so the host on screen and the
   `href` always come from one parse, even for a consumer that is not the
   block renderer. The payload is `{ kind: "link", url, title?, description? }`
   and mirrors the props, so D41 §4 holds unamended. The attribution line
   ("Title and summary by the brain · page not opened or checked") is fixed
   kit text, not a payload field.
4. **A policy refusal rejects the `show_block` call**, with the reason, the
   same way a schema failure does, so the model can correct itself. D41 §1's
   "the handler validates and echoes" stays true: every echoed payload is
   valid. The client classifies again anyway, and draws Link withheld for
   anything that still fails, such as a replayed transcript or a payload
   written under a looser policy. The withheld card is the fail-closed
   fallback, not the normal refusal path.
5. **The ASCII host is the headline.** The `xn--` form is what the browser
   resolves, and with no confusables table it is the only defence against an
   all-Cyrillic lookalike, which passes the UTS #39 Highly Restrictive check.
   `reads as …` is the secondary line. A label that mixes scripts, and any
   default-ignorable or bidi-control code point, is refused. Other IDNs are
   not refused wholesale.
6. **A new package edge: ui-sdk → ui-kit.** The `show_block` handler
   (`handleShowBlock`, `packages/ui-sdk/src/server/bridge-tools/show-block.ts:29-52`)
   has to call `classifyLink`, and the two packages did not depend on each other. ui-sdk
   takes a workspace dependency on ui-kit, and only on its React-free `links`
   export. That gives one implementation and one test suite. The edge goes
   through the `release` skill's checks.

**Alternatives refused.**

- *A fetched preview* (title, favicon, image from the destination): it is an
  egress channel opened on the model's say-so, plus a caching and
  failure-handling service. The renderer is denied every egress channel, and
  this would be the first hole. If a real preview is ever wanted, it gets its
  own issue and its own egress discussion.
- *A model-supplied `host` or `source` field*: a field that can disagree with
  the URL is a field that can lie.
- *Echoing a refused payload with a note in the tool result*, the spec's
  first draft: the model learns nothing it can act on, and the reader gets a
  withheld card for a mistake the model could have fixed.
- *The classifier in ui-sdk, with the kit receiving derived strings*: a kit
  consumer that is not the block renderer could then show a host that did not
  come from the `href`.
- *A "mentions another site" note* (a title naming `paypal.com` over a link
  to another host): detecting a hostname needs a TLD list that goes stale, and
  a heuristic that misses a case reads as "the title matches the
  destination", which is exactly what nothing on the card may imply.
- *Registrable-domain emphasis*: it needs the Public Suffix List, a bundled
  dataset that goes stale, and a wrong guess (bolding `co.uk`) is worse than
  none.
- *A confirm dialog after Open*: the anchor is the explicit act, and a second
  yes is one the reader learns to skip.

**Not decided here.** Markdown links in prose are D49. Links in a shared PNG
or PDF are #558.

**Built 2026-09-28 (#43).** The build held to the ruling above. What it
found, and what the ruling did not say:

- **Where each part landed.** The handler throws with the reason
  (`handleShowBlock`, `packages/ui-sdk/src/server/bridge-tools/show-block.ts:29-52`).
  The payload parse on the client stays structural, and the card classifies
  again. The card's link mode calls `classifyLink` itself
  (`LinkCard`, `packages/ui-kit/src/blocks/LinkPreviewCard.tsx:294-512`), and
  there is no `host` prop and no `host` field. The payload
  (`LINK_BLOCK_SCHEMA`, `packages/ui-sdk/src/tool-contracts/blocks.ts:429-449`)
  mirrors the props. `classifyLink` (`classifyLink`, `packages/render-template/src/links.ts:252-311`)
  is pure. The edge table records the new dependency
  (`"@schlessera/brain-ui-sdk"`, `tests/allowed-edges.ts:70`), and ui-kit now
  builds and publishes ahead of ui-sdk. At that point the kit's own row was unchanged.
  #558 later moved the pure classifier to the template's `./links` leaf and
  added the kit-to-template edge; D13's purity gate still holds.
- **One reading of the spec, stated.** The spec says "UTS #39 Highly
  Restrictive" and lists the allowed mixes as Han with Hiragana and Katakana,
  with Bopomofo, and with Hangul. UTS #39 includes Latin in each of those
  three sets, so a Japanese brand name with Latin letters in it is not
  refused. The implementation follows the standard
  (`ALLOWED_MIXES`, `packages/render-template/src/links.ts:215-219`). Latin with any
  other script (Cyrillic, Greek, …) is still refused.
- **How "nothing is fetched" is proved, and its measured blind spot.** The
  browser test reads every request from Playwright on the Node side
  (`startRequestLog`, `packages/ui-kit/tests/visual/request-log.ts:20-32`),
  across the whole browser context so a new tab is seen. An in-page spy
  misses an `<img>` and a navigation, and Resource Timing misses a failed
  request, which is every request to `.example`. Mutating a `/preview.png`
  image or a scripted prefetch into the card turns the test red on that log.
  A `/favicon.ico` image did not: Chromium routes it so that Playwright
  reports no request. So the test also asserts that the card contains no
  element or style that can load anything, and that assertion is the one
  that fails for the favicon.
- **One more alternative refused.** *Take a derived `destination` prop* (the
  spec's §8): the kit would trust its caller for the host, and the payload
  would stop mirroring the props.

## 2026-09-28 — D49: a prose link goes through D48's classifier on every markdown surface, and `mailto:` stays live (#551)

**Ruled 2026-09-28, before implementation.** As with D48, the implementing PR
appends what building it found. The presentation (how the host sits in
running text, and how a withheld link reads) is still to be designed on the
issue, so this entry fixes the behaviour and not the look.

**Question.** D48 puts every model-authored link card behind `classifyLink`.
A markdown link in the answer's prose gets none of it. The `a` override
(`a: ({ href`, `packages/ui-react/src/components/chat/brain-markdown.tsx:170-181`)
draws every link that is not a repo path as a bare
`<a target="_blank" rel="noopener noreferrer">`. The only filter is
react-markdown's default `urlTransform`, which strips `javascript:` and
`data:` and nothing else. So `[your bank](https://account-check.example)`
shows "your bank" with no destination: D48's phishing shape, one layer down,
in the place it is easiest to produce.

**Ruling (maintainer, recorded on #551).**

1. **One policy.** Every anchor the override draws, apart from repo
   `FileLink`/`DirLink` links, goes through `classifyLink`. There is no
   second URL parser and no prose-specific loosening of the web rules, so a
   prose link and a link card never disagree about the same URL.
2. **Every `BrainMarkdown` surface, not just answers.** The override is
   shared by answers, share blocks, `ask_user` cards, the briefing and the
   file viewer. All are covered, because the corpus holds clipped external
   content, and a note is no safer to click than an answer. `remark-gfm`
   autolinks are covered too.
3. **An accepted link shows its host.** The text stays the anchor text, and
   the verdict's ASCII host sits beside it, e.g.
   `your bank (account-check.example)`. The `href` and the host come from the
   same verdict. The anchor gets `rel="noopener noreferrer nofollow"` and
   `referrerpolicy="no-referrer"`.
4. **A refused link is inert.** It is plain text: no `<a>`, no
   `role="link"`, nothing that navigates, and no later pass may promote it
   back into a link.
5. **`mailto:` is the one prose-only exception.** It stays a live anchor,
   with the address from the same parse shown beside its text. The raw-string
   checks still run first, and a failure makes it inert. It is a named check
   beside `classifyLink` in the same `links` module, with its own tests, and
   not a loosening of `classifyLink`: the `link` block still refuses
   `mailto:`. Every other scheme `classifyLink` refuses (`xmpp:`, `irc:`, …)
   is inert.

**Alternatives refused.**

- *Leave prose links as they are, with the block as the supported way to
  show a link*: it leaves D48's threat open in the one place a model reaches
  for without being asked.
- *Stop rendering prose anchors, and tell the model to use the `link`
  block*: it kills every link in the user's own notes along with the
  model's, and it leans on prompt text, the lever D42 measured at 0 of 5.
- *Only model-authored surfaces, with the file viewer keeping plain
  anchors*: it needs a prop saying who wrote the text, and clipped pages in
  the corpus are no more trustworthy than an answer.
- *Inert `mailto:` like every other refused scheme*: an email address in a
  note is ordinary content, and showing the address beside the text already
  answers what the link does.

**Not a contract change.** Prose rendering is not in
`docs/integration-contract.md`.

**Not decided here.** A shared PNG or PDF draws links with `marked` in
`render-template` (D46), not through this override, so it keeps
hidden-destination links until #558 is ruled. "Copy as rich text" copies the
rendered DOM, so it inherits this treatment.

**Built 2026-09-28 (#551).** The presentation is the design comment on
#551, approved there, and the build held to it and to the ruling above. What
it found, and what neither said:

- **Where each part landed.** Every non-repo anchor the override draws is a
  `ProseLink` (`ProseLink`, `packages/ui-react/src/components/chat/prose-link.tsx:27-57`),
  which makes the one `classifyLink` or `classifyMailto` call its `href` and
  its host both come from. The mail check sits beside `classifyLink`
  (`classifyMailto`, `packages/render-template/src/links.ts:371-405`), and the
  streaming hold is a pure function applied to the answer's last text part
  while it streams (`holdOpenLink`, `packages/ui-react/src/lib/stream-link-hold.ts:104-112`).
- **The override never saw what the author sent.** mdast-util-to-hast
  percent-encodes a link's URL before react-markdown's `urlTransform` blanks
  any scheme it dislikes. A U+202E in a path arrived as `%E2%80%AE`, which
  `classifyLink` accepts, and `javascript:` arrived as `""`, which reads as
  relative. A remark plugin now carries the address as written beside the
  `href` (`remarkRawHref`, `packages/ui-react/src/components/chat/prose-link.tsx:156-178`),
  and a reference link takes its definition's. Deleting the plugin from the
  list turns the refused-link tests red.
- **Chrome breaks a host at a `-`.** A `<wbr>` after each "." adds break
  opportunities but removes none, and real Chrome at 288px broke
  `harbour-master` at its hyphen. Each label is an inline block, as the
  card's host is (`.bk-plink-label`, `packages/ui-react/src/theme.css:334-338`),
  with "(" in the first label and ")" in the last. Only a label wider than
  the line wraps within itself.
- **A mail address's local part is ASCII `dot-atom`.** The design gave the
  domain the web host's rules and said nothing of the local part beyond
  hidden characters. A non-ASCII local part is refused as `unparseable`,
  because there is no ASCII form to show for it. The domain goes through
  `classifyLink` itself, as the host of an `https:` address.
- **A withheld link's text inherits its ink** rather than taking
  `--bk-color-ink`, so inside an amber `h2` or a dim `em` it still reads as
  the words around it. In a paragraph the two are the same colour, which the
  Chrome test asserts.
- **Link text is never linkified, accepted or withheld.** The text passes
  that turn repo paths and wikilinks into links stand down inside any prose
  link (`withTextProcessing`, `packages/ui-react/src/components/chat/brain-markdown.tsx:47-57`),
  because an anchor inside an anchor is not HTML either. The same wrapper
  had been writing react-markdown's `node` object into the DOM as
  `node="[object Object]"`, and no longer does.
- **Three edges the design did not list.** A markdown link title is dropped:
  it was the author's words in a hover-only tooltip. The streaming hold also
  holds a closed `[text]` that ends the buffer, since `(` may be the next
  token, and an image's `!` goes with its `[`. The `bk-sr` class the design
  names did not exist, and is defined beside the link rules.
- **How "nothing is fetched" is proved.** In real Chrome, Puppeteer's
  `request` event and the browser's `targetcreated` event see nothing while
  the fixture renders, every link is hovered and every withheld link is
  clicked. Clicking an accepted link then opens a tab to its destination,
  which the same listeners see, so the harness is shown able to observe what
  the first half says never happens.

**Print/export treatment, 2026-09-30 (#558).** The same pure verdict now owns
app export hrefs and visible ASCII hosts or validated mail addresses. Relative
repo/file targets stay inert with readable target information; safe local
fragments retain local navigation without inventing a host. Mail queries are
stripped. The no-referrer/rel treatment is retained. Markdown link tokens keep
their original addresses until classification, before URI encoding can conceal
raw controls; HTML entities are resolved structurally. Parser-located href
attributes preserve literal/numeric NULs before HTML can replace them, and
autolinks use the classifier's redacted display after raw refusal. Classification rules,
including accepted percent-encoded web paths, are unchanged.

Print uses the approved parenthesised, monospace destination, one wrapping DNS
label at a time and no ellipsis, with a 12px print legibility floor. Exact plain destination text keeps the D49
redundancy rule, while its text is still protected against supplied CSS. An
existing suffix is rebuilt from the current verdict, so repeated processing
does not duplicate labels and source-supplied markers cannot bypass policy.
The renderer verifies disclosure in the final media mode and finished PDF; HTML attributes alone
do not prove PDF safety. See the D46 addition above for alternate markup,
isolation, failure behavior and runtime proof.

## 2026-09-28 — the `map` block: the model names places, the surface draws them (#44)

D41 §2 held agent-authored pins back as "a later variant". This is that
variant. `show_block` gains `map`: 1 to 30 places with optional
coordinates. The kit gains `PlaceMap`, which is one frame, two, or none,
with a numbered list that always carries every place. `MapView` gains a
numbered pin mode whose merges are lettered. The payload is data only, as
D41 requires, and it carries nothing that shapes the drawing. The geometry
ruling, the rules that came with it, the design and the two points the
build changed are recorded in [map-geometry.md §8](map-geometry.md#8-places-the-model-names-on-the-same-geometry--2026-09-28-44),
which is where anything about maps is decided.

The classification pass does not route to `map`. Its figures are
coordinates, and a coordinate the text does not state is exactly what the
block must never invent. That is D45's reason for leaving `trend` and `bars`
to the tool, and it applies here for the same reason.

## 2026-09-28 — D50: the model may offer two follow-ups, drawn under the answer, that fill the composer and never send (#40)

**Question.** `SuggestionChips` was used only for the welcome state, a fixed
set the app chooses. Should the model author chips as follow-ups to its own
answer, and if so, what does taking one do, where does the row sit, and what
does a replayed session show?

**Ruling (maintainer, recorded on #40).** Yes, within these limits.

1. **A chip fills the composer and never sends.** Its words go below the
   reader's draft, which is kept byte for byte, and the caret goes to the end.
   It is never a `chat_message`, never the answer to a pending question and
   never an approval. *Rejected: sending on tap.* The model wrote the words,
   and a tap would run them before the reader could change them. Zero, one or
   two suggestions per answer. None is a valid answer, and generic filler is
   not offered.
2. **The payload is the kit's data, minus tone.** The schema
   (`suggestionsBlock`, `packages/ui-sdk/src/tool-contracts/blocks.ts:603-630`) carries the row's
   `label` and `items[1..2]{label, icon?}`: `SuggestionItem` without `onClick`,
   which is a callback, and without `tone`, because a suggestion carries no
   effect and so is never amber. `packages/ui-react/tests/block-contract.test-d.ts`
   asserts the keys equal in both directions. Adding `tone` to the schema turns
   that test red, and the PR that added it recorded the mutation. The
   maintainer's 2026-10-02 ruling on #635 makes new calls reject unknown
   fields at both the suggestions block and item levels, including `tone`;
   both backends advertise and enforce the restriction. Stored and replayed
   payloads instead discard unknown fields so otherwise valid suggestions
   keep rendering. Malformed payloads keep the generic fallback. Other
   block kinds are unchanged. This accepted-input tightening is a breaking
   change shipped as a pre-1.0 minor.
3. **A separate app component draws it.** `AnswerSuggestions` in ui-react uses
   the kit's `Icon`, its untoned chip colours and `.bk-control`. It adds what
   the kit's welcome chip lacks: a real `<button>`, a 44px target, and text
   that wraps instead of ellipsising, because the chip IS the prompt. The
   welcome chips do not change.
4. **An exception to D41 §3: it is not drawn where it is called.** The turn's
   last call that parses is lifted to the answer's closing row, after the text
   and the share menu. At its call position `groupParts` draws nothing
   (`payload?.block.kind === "suggestions"`,
   `packages/ui-react/src/components/chat/message-bubble.tsx:274`), and shares
   and prints leave it out. This also amends D37 §8's "chips while live,
   `FeedbackRow` later": #41 closed as not planned, so the closing row is
   suggestions or nothing.
5. **Replay draws what live drew.** One pure function decides the row
   (`visibleSuggestions`, `packages/ui-react/src/lib/answer-suggestions.ts:118-139`).
   It reads only the transcript and state that is current either way. The
   flip (D38 §8) is any message after this one. S1 is the session's run
   state, which a resume sets from the status frame the server sends after
   the history. S3 is an `ask_user` exchange without answers, which history
   rebuilds from the tool calls. S4 is the answer's last text ending in `?`.
   S5 and S6 are the voice store. S8 means no parsed call, or nothing
   surviving the drops.
6. **A voice-conversation turn is suppressed by its user message's `source`.**
   ui-server keeps a message's source and joins it onto the replayed history
   (#549), so the rule holds on replay as well.
7. **Errors are suppressed only by #191's error card, live and on replay
   alike.** Until it lands there is no error suppression. A cancelled turn is
   never suppressed: the model calls suggestions last, so a turn that reached
   the call has an answer.
8. **The rule rides in the tool description, not the brief.** The brief sits
   at its pinned eleven lines and 749 characters, and with the tools always
   loaded (D44) it measured no effect on the call rate. The description, which
   D44 puts in every prompt, carries a `suggestions:` line. The brief's
   "names every kind" assertion exempts `suggestions` by name
   (`BRIEF_EXEMPT`, `packages/ui-sdk/tests/tool-contracts.test.ts:122-126`).
9. **It merges before it is measured, and the release waits.** #550 runs the
   keyed measurement on both backends: the suggestion rate, the rate when the
   answer ends in a question, the drop rate, the added tokens, and a read of
   the kept suggestions as grounded or filler. The release that first ships
   this is not cut until #550 closes.

**Targets.** A one-line chip paints about 29px. Its target reaches 8px past
the paint on every side (`.answer-chip::before`,
`packages/ui-react/src/theme.css:622-626`), and the chips sit 16px apart on
both axes, which is D34's half-the-gap limit. The hairline is an inset shadow,
not a border, so the reach is measured from the paint.
`tests/answer-suggestions-targets.test.tsx` lays the row out in real Chrome
at 320px and 1280px. It asks `elementFromPoint` for the point 1px inside each
edge of each target and asserts the border is zero. With the reach removed,
all four edges read false. The same file runs axe on the row in both themes.
A first axe run failed on colour contrast because it measured mid-fade,
which is why the test now waits for animations to finish.

**Proof.** `packages/ui-react/tests/render/answer-suggestions.test.tsx` mounts
the real `ChatPage` and `Composer` on a root with a fake socket. It asserts
each suppression rule twice, once on a turn built from live frames and once
on the same turn replayed from `session_history` followed by its status
frame. Every row of #40's
composer table is covered, with the assertion that nothing was sent. For each
guard, the test named for it failed when the guard was removed: S1, S3, S4,
S5 and S6, S7 (in the decision itself; ChatPage's `closing` prop is only a
render filter), S8, S9, the drops, the last call winning, the empty call
position, the kept draft, the share omission, and the classified-span filter.


### D50 measurement instruments: description arms and item accounting (#550)

The two harnesses select the same six prompts with `--suggestions`: three
answers with a plausible next step, and three controls that ask the model to
end its answer with a question. Both arms retain the shipped schema, brief and
always-loaded bridge tools. `rule` carries the shipping description;
`no-rule` removes only its `suggestions:` line, including the instruction to
call it last. The description's opening sentence still names the variant in
both arms. On the server, a Bun preload changes that single source line in
memory before either backend loads, in a fresh subprocess for each arm. The
keyless test lists both backends' tools and executes their real handlers to
prove that their schemas and accepted suggestions are identical across arms.

The rate is per completed turn with a parsed suggestions call. A parsed call
whose items all drop still counts as a call. Rejected calls, subagent calls,
incomplete turns and server turns that left the corpus are excluded. The
question-control rate and the rate over answers whose actual final text part
ends in a question are separate: asking the model to end with a question does
not prove that it did. Item accounting follows the client in order: empty
normalized label, duplicate, repeated user prompt, then generic filler, using
the same case/punctuation folding. Drops are measured over all accepted calls'
items. Only the last
accepted call supplies the transcript's kept-item sample; question-ending
suppression is stated separately from item drops. A quality verdict needs a
read of those transcripts, rather than another automated predicate.

Keyless schema arithmetic on 2026-09-30, using Bun 1.3.14 and the Agent SDK's
actual `tools/list` serialization: the description line adds **336 JSON
characters**; adding the variant adds **808** characters to the shipped flat
schema and **651** after D47's `definitions` transform. D47's calibrated
marginal range estimates **131–140**, **315–337** and **254–272** input tokens,
respectively, per model round trip. These are estimates; the counted command
below measures the description and variant separately against the same tool
name. The schema without the variant is only a token-count baseline, never a
live arm. These character counts and their provenance do not establish a live
rate or a keep/change/remove verdict.

After #635's two `additionalProperties: false` declarations, the same
keyless listing on 2026-10-02 adds **866** flat-schema characters and **709**
after the definitions transform; the description remains **336** characters.
These updated counts do not supply the live measurements reserved for #550.

The maintainer's 2026-10-07 ruling pins new comparisons to
`claude-sonnet-5-5`. Earlier observations on `claude-sonnet-5` keep their
original model identity and are not pooled with the new comparison.

Reproduction commands (live commands require authorized API use):

```sh
# Keyless estimate and checks.
bun scripts/measure-show-block.ts --suggestions --schema-cost
bun run test tests/measure-suggestions.test.ts

# SDK level: 6 prompts x 2 arms x 3 repetitions = 36 turns.
bun scripts/measure-show-block.ts --suggestions --reps 3 --out sdk.json --md sdk.md
bun scripts/measure-show-block.ts --suggestions --tokens

# Server level: 36 turns per backend, each against a separate fixture copy.
# Copies live outside any checkout and home directory and are indexed first.
bun scripts/measure-show-block-server.ts --suggestions --brain <claude-fixture-copy> --backend claude --model claude-sonnet-5-5 --runs 3 --out claude.json
bun scripts/measure-show-block-server.ts --suggestions --brain <pi-fixture-copy> --backend pi --vendor anthropic --model claude-sonnet-5-5 --runs 3 --out pi.json
bun scripts/measure-show-block-server.ts --report claude.json
bun scripts/measure-show-block-server.ts --report pi.json
```

Keep the reports separate by backend and model. The server report refuses to
pool unlike backends/models or legacy block-rate records with suggestion
records. The run files retain the answers, parsed items, drop reasons and
runtime/package versions for review. Keyless tests compare the counter's
survivors and question-ending decisions with the actual client's functions,
and drive accepted, rejected, malformed, subagent and failed-turn frames
through the server instrument over a real socket. Removing each guard makes
its named behavioural assertion fail.


### D50 Sonnet 5.5 measurement and verdict (#550, 2026-10-07)

Keep the shipped description and variant. The completed comparison used six
prompts, both description arms and three repetitions through the SDK, Claude
server and Pi server: 108 completed turns, with no scored exclusions.

| Instrument | Answer turns with suggestions, rule | No-rule | Question controls, each arm |
| --- | ---: | ---: | ---: |
| SDK / Claude subscription | 0/9 | 0/9 | 0/9 |
| Claude server / subscription | 0/9 | 0/9 | 0/9 |
| Pi server / Anthropic API key | 2/9 | 0/9 | 0/9 |

Actual question-ending turns also had zero calls in every arm. No question
control emitted a row, so this does not prove active client suppression.
Pi's rule arm emitted four items; all four passed the client predicates, with
zero empty, duplicate, prompt-echo or filler drops. Zero-item arms have null
drop and quality denominators. All four labels are concrete and grounded in
the prose or accepted rendered comparison; the combined-workflow label is
weaker because the answer already supplies a workflow outline.

The subscription-authenticated token-count endpoint estimates a marginal
107 input tokens for the description and 377 for the variant. The updated
866 flat-schema and 709 definitions-transform characters imply D47 calibrated
ranges of 338–361 and 276–296 tokens; the 336-character description implies
131–140. These counted endpoint observations are not future invoice proofs.

This supports a small observed Pi benefit and no demonstrated Claude benefit.
The fixed arm order, three repeated answer prompts, backend/tool differences
and Pi API-key route limit generalization. No brief, variant, runtime filter
or payload change follows. The
[full report](../../scripts/measurements/suggestions-2026-10-07/report.md)
retains all transcripts, item judgments, exact models/runtime versions,
reviewed input hashes, private-data isolation limits, usage and billing
provenance, and parameterized reproduction sources.


## 2026-09-30 — D51: recoverable failures stay in their turn, and outward diagnostics require review (#576)

**Ruling.** The [recovered composition](https://github.com/schlessera/brain-kit/issues/576#issuecomment-5906135339)
and the [maintainer's corrections](https://github.com/schlessera/brain-kit/issues/576#issuecomment-5906946639)
are the design. A red or gold hairline `Surface` follows the partial answer
and tool timeline under the existing turn header. Class-driven copy states
only what the payload establishes. It promises no empty workspace, rollback,
fixed recovery time or absence of prior tool effects. Missing model, runtime
version, time and total call counts are omitted. #631's observed counts are
retries and appear as `retries` in the receipt; they never imply an initial-call
total. The normalized per-turn observations supplied by #630 and #631 survive
replay. D50's error suppression now applies
live and on replay, even when the failed turn had offered valid suggestions.

`TurnErrorCard` composes the kit's `Receipt`, `Disclosure`, inert `DiffBlock`,
`Button` and polite `InlineToast`. The provider message is redacted as best
effort before display, never parsed as markup or allowed to choose actions.
Long messages wrap; the initial preview is capped at forty explicit lines
or 4,000 characters, with a named expansion showing the full text. All
controls have 44px targets. Only live arrival creates an alert; its text is
fixed for the life of the card, and replay creates none. Reduced motion
removes the transcript entrance animation.

Subscription `authAction` remains authoritative: its established instruction
is reproduced verbatim with `for whoever runs this server`. An explicit-key
profile or generic pi auth failure gets neutral credential wording. No
Settings sign-in, new auth workflow or model-switch action is invented. All
model switches wait for #61's linked-session design.

Retry is confined to the latest eligible failure and starts a distinct turn
with the host-retained original request, including image bytes and effective
prompt. The warning says prior actions may run again. An atomic delivery
receipt prevents duplicate starts from a double tap or repeated delivery.
The client stores only correlation ids and checks delivery after reconnect;
unconfirmed delivery is not an invitation to resend. A refusal restores the
action. An unclassified failure gets one manual retry. Server errors offer
Report after a repeated observed failure.

When a reported absolute reset is in the future, the latest eligible action
reads `Retry · in Ns` and is disabled until that timestamp passes. The same
deadline governs live arrival and replay; reopening the transcript never
starts a new delay. Countdown updates do not change the fixed live-failure
announcement. Expiry does not override a pending send or an uncertain delivery:
`Check delivery` remains available to reconcile an acknowledgement, including
while a cooldown is still active. Unknown or expired resets add no wait.

Copy and Report first open an editable, exact outgoing preview in the kit's
`BottomSheet` inside a native modal. Its keyboard focus is trapped and
returned to the opener. The default diagnostic allowlist contains protocol,
known class and observed status, plus product auth instructions when relevant.
Provider text is optional, redacted as best effort and capped visibly at
1,500 characters. The reader can edit every byte. Copy occurs only on the
final Copy action; opening Report transmits the reviewed URL payload to
GitHub before issue submission, which the sheet states explicitly. A long
URL is refused with a copy-and-paste fallback, never silently shortened.
There is no promise that heuristic redaction catches all private content.

**Activity failures (2026-10-05, #598).** The same review serves failed
Activity runs, under the [approved proposal](https://github.com/schlessera/brain-kit/issues/598#issuecomment-5974850029)
and its [corrections](https://github.com/schlessera/brain-kit/issues/598#issuecomment-5981210012).
`DiagnosticReview` moved to `components/report/` and gained an editable title,
explicit inclusions and a URL-length meter; the chat card keeps its copy.
`Send bug report` appears only where `isFailureOutcome` holds: as a 44px
sibling of a history row, reading `Report` below 480px, and under the receipt
in run detail. Its accessible name always names the run, outcome and time.
The default facts are protocol, client release, server release and commit when
`/api/status` was read, origin, outcome, duration, record state, built-in
failed-step tool names and billing. Failure text and job name are explicit,
redacted and capped inclusions. Names, IDs, paths, payloads and traces are never
generated. A pruned, missing or unread record says so in words. Opening the
review from a row reads only that run's record from this server, without
payloads, and changes nothing.

## 2026-10-06 — D52: Sessions is a destination, work left running is tracked until seen, and every session keeps its own draft (#943)

**Sources.** The maintainer's [navigation design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973564827)
and the later [parallel-session design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973572791),
which takes precedence where the two disagree on placement. Then the
maintainer's rulings on [#929](https://github.com/schlessera/brain-kit/issues/929)
and [#943](https://github.com/schlessera/brain-kit/issues/943): authoritative
host recovery (**Recovery A**, 2026-10-04), a separate draft per session
(2026-10-04), host-backed draft storage across devices (**storage C**,
2026-10-04), the [shared row above the composer](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5992839917)
and its [≥1280 answer](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5992922056)
(2026-10-05), and the [maintainer's approval](https://github.com/schlessera/brain-kit/issues/943#issuecomment-5998985495)
of the [six-part #943 design](https://github.com/schlessera/brain-kit/issues/943#issuecomment-5980283574)
(2026-10-04) with its four residual answers, R1–R4 (2026-10-05). Where
those later rulings do not replace it, the supplied navigation and
parallel-session designs still bind; §8 lists what carries over. The measured input is
[`docs/plans/navigation-recovery.md`](../plans/navigation-recovery.md)
(#942). The row's adopted geometry is the
[shared-row design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5998113323),
which amends the #943 strip.

**What this amends.** D37 §1's destinations and New chat placement; D22's
≥1280 list pane and the space between transcript and composer; and the
drawing of #93's New chat disc. It replaces the supplied tracker rules
(`{sessionId, leftAt, seenTurnId}` in a global `brain-trackers` key, and
`lastActiveAt > leftAt → done`) and the supplied draft-discard
confirmation, which never shipped. Permission gates, cost honesty
(D38 §5), data-only rendering, root isolation and the module seams are
unchanged. This record implements nothing: the native children of #929
build it, and #964 and #979 add the host contracts in §6.

### 1. Destinations, acts and the palette (amends D37 §1)

- **Destinations.** Rail: Chat, Sessions, Actions, Files, Settings, on
  ⌘1–⌘5. Phone bar: Chat, Sessions, Actions, Files, More. Graph is no longer
  a destination: it is reached through phone More and the palette's Jump to,
  with no key. Graph's contents are unchanged.
- **The key remap is explicit.** Today the keys are ⌘1 Chat, ⌘2 Actions,
  ⌘3 Files, ⌘4 Graph, ⌘5 Settings ([`const jumpTo`](https://github.com/schlessera/brain-kit/blob/18d5ddee154b5dbebb3dbd6c487bc8ea1fc036db/packages/ui-react/src/components/layout/desktop-palette.tsx#L84-L89)).
  After: ⌘1 Chat, ⌘2 **Sessions**, ⌘3 **Actions**, ⌘4 **Files**, ⌘5 Settings.
  Graph loses ⌘4 and gets no key.

  > **2026-10-06 — Implementation context (the key remap above).** "Today"
  > is the code before #946, at the pinned link. #946 made the remap: the
  > destinations and their keys are now `const destinations` in
  > `packages/ui-react/src/components/layout/desktop-routes.ts`, shared by
  > the rail and the palette. The ruling still binds.
- **Rail acts** sit under the destinations: Search, Add a note and Daily
  briefing (printing `spends`) when expanded; Search and Add when collapsed,
  where the briefing is reached through All commands. The act section holds
  at most four rows.
- **All commands** is a clickable button that replaces the rail's passive
  ⌘K cap, named `All commands` with `aria-keyshortcuts="Meta+K"`. It is the
  non-keyboard route to every command without a row of its own (Graph, Sync,
  Stats), so there is no keyboard-only exception.
- **Phone.** Occupied Chat gets a Search disc beside New chat. The welcome
  chips are the briefing (with `spends`), Search and Add; Add replaces the
  welcome statistics chip. More holds Settings, Graph, Add, the briefing,
  Sync and Stats, each printing its effect and its actual unavailable reason.
- **Palette.** Every unique command and its grouping by what ⏎ does stays
  (D37 §3). Sessions appears once, under Jump to: the former act row and the
  new destination row merge. Graph moves to Jump to.
- **New chat** stays off every bar and rail slot. Below 1280 it is the Chat
  overlay disc (#93's drawing, now through `DiscButton`, §7) and a palette
  row. At ≥1280 it is the Sessions pane's `New conversation`, the pane's one
  primary action, and a palette row; there is no New chat disc and no rail
  row. It still has no key (D38 §5).

**Usage classes are preference, not measurement.** The maintainer's
classes: New chat and Sessions are session-level (S); Search is S,
provisionally; Add and the briefing are daily (D); Files, Graph, Sync and
Stats are occasional (O). Actions and Settings have no class. No usage
statistics were generated, and none should be cited as if they had been.

**The row cap is placement, not classification.** When a fifth act
qualifies for the rail, the least frequent act's *row* moves to the palette
and More. Its class stays what it was, and the placement table marks it
`D · rail full`. Today there are three acts, so nothing moves.

### 2. The activation contract

The supplied width and view exceptions are adopted as the contract, in place
of the original epic's promise of every daily act in one activation from
anywhere. On the phone, Add and the briefing take two activations from
occupied Chat; on the collapsed rail the briefing takes two; phone Search is
one activation from Chat and may be two from elsewhere, via Chat. **No
control is added to restore the superseded promise.**

Counts are pointer or touch activations; typing a slash query does not
count. `0` means already there. Opening Search or Add opens a form and
writes nothing; opening Sync or the briefing starts that job (Sync writes,
the briefing spends).

**Phone, 320 and 390.**

| Target | Empty Chat | Occupied Chat | Sessions | Actions | Graph | Files / Settings open |
| --- | --- | --- | --- | --- | --- | --- |
| Chat | 0 | 0 | 1 | 1 | 1 | 1 (panel closes) |
| Sessions | 1 | 1 | 0 | 1 | 1 | 1 |
| Actions | 1 | 1 | 1 | 0 | 1 | 1 |
| Files | 1 | 1 | 1 | 1 | 1 | 0 / 1 |
| Settings | 2 · More | 2 | 2 | 2 | 2 | 2 / 0 |
| Graph | 2 · More | 2 | 2 | 2 | 0 | 2 |
| New chat | 0 · already new | 1 · disc | 1 · New conversation | 2 · Sessions → New conversation | 2 | 2 |
| Search | 1 · chip | 1 · disc | 2 · Chat → disc or chip | 2 | 2 | 2 · Chat → disc |
| Add a note | 1 · chip | 2 · More | 2 | 2 | 2 | 2 |
| Daily briefing | 1 · chip, `spends` | 2 · More | 2 | 2 | 2 | 2 |
| Sync · Stats | 2 · More | 2 | 2 | 2 | 2 | 2 |
| Open a session | 2 · Sessions → row | 2 | 1 | 2 | 2 | 2 |
| Open a tracker | 1 · pill | 1 · pill | 1 · Working row | 2 · Chat → pill | 2 | 2 |

**Collapsed rail, 480–899.**

| Target | Empty Chat | Occupied Chat | Other view | Panel open |
| --- | --- | --- | --- | --- |
| Any destination | 1 (0 if current) | 1 | 1 | 1 |
| Graph | 2 · All commands → Graph | 2 | 2 | 2 |
| New chat | 0 | 1 · disc | 2 · Chat → disc (1 from Sessions) | 2 |
| Search · Add | 1 · rail | 1 | 1 | 1 |
| Daily briefing | 1 · chip | 2 · All commands → row | 2 | 2 |
| Sync · Stats | 2 · All commands | 2 | 2 | 2 |

**Expanded rail, 900–1279.** As 480–899, except the briefing is one
activation from anywhere: a rail row printing `spends` at rest.

**1280 and 1440.** Chat carries the rail, the Sessions pane and the
transcript. There is no disc and no tracker pill row.

| Target | Chat (empty or occupied) | Actions / Files / Settings | Panel open |
| --- | --- | --- | --- |
| Rail Sessions | 1 · focus moves into the pane at the selected row; Chat stays the amber destination | 1 · Chat opens with the pane focused | 1 |
| New chat | 1 · pane `New conversation`; in empty Chat it is `aria-disabled` with the reason `already a new chat` | 2 · Sessions → New conversation, or All commands → New chat | 2 |
| Open a session or tracker | 1 · pane row | 2 | 1 |
| Search · Add · briefing | 1 | 1 | 1 |
| Graph · Sync · Stats | 2 · All commands | 2 | 2 |

**Rules.**

- **N1 · A panel is not a place.** Activating any destination or act
  replaces an open panel, with no separate close step.
- **N2 · Closing returns focus.** Esc, back, or `Close files` /
  `Close settings` (#965's names) returns focus to the control that opened
  the panel. Chat's scroll position and selection are unchanged.
- **N3 · Pressing the current destination** scrolls it to its start and
  moves focus: in Sessions to the first Working row, otherwise to the
  selected row. It never clears a selection, a draft or a tracker.

  > **2026-10-06 — Amended for Chat ([N3 addendum](#d52-addendum--what-n3-means-for-each-destination-maintainer-2026-10-06)).**
  > Chat's start is its latest turn, and on a phone focus stays on the Chat
  > tab unless a card is waiting. The addendum also says what "start" and
  > "the selected row" are for every destination and width.
- **N4 · The adopted exceptions stand** (above).
- **N5 · No New chat rail row at ≥1280:** an act takes no destination slot,
  and the pane has its one primary action.

**Reasons are printed at rest, never only on hover.** A disabled rail
briefing prints `spends` with a second line, `needs the host` or
`a turn is running`. More keeps `sync` printed when disabled. Welcome chips
gain `disabled` and `why` (§7).

**Accessible names.**

| Control | Name |
| --- | --- |
| Rail acts | `Search the brain` · `Add a note` · `Daily briefing, spends` (disabled: `…, unavailable: {why}`) |
| Palette button | `All commands`, with `aria-keyshortcuts="Meta+K"` |
| Discs | `Search the brain` · `New chat` · `Scroll to latest` |
| Tracker pill | `{label}, {state}{, second line}. Open session.` |
| Tracker summary pill | `{n} more working sessions: {counts}. Open list.` |
| Keyboard-open tracker summary | `{n} working sessions: {counts}. Open list.` |
| Pending pill | `Pending follow-up {n} of {total}: {label}. Not yet received by the agent.`, with the full text as its description |
| Pending summary | `{n} pending follow-ups. Open list.` |

### 3. The shared row above the composer (amends D22)

Below 1280 the row between the transcript and the composer carries two pill
systems: **working sessions in the left half** (this record's trackers, §4)
and **pending follow-ups for the open session in the right half** (#1002:
messages sent while the session is busy that the agent has not yet
received). At ≥1280 trackers live in the Sessions pane, above its date
groups, and the row carries **only the right half**; the left half is
empty. Pending follow-ups are not D50's model-offered suggestion chips,
which stay under the answer.

**Geometry.**

- The row is a **sibling** between the message area and the composer, never
  an overlay. It is a two-column grid with an 8px gutter over the composer's
  own width and measure (720px at most); each half is
  `(composer − 8px) / 2`.
- **Each half is a hard box.** Content never crosses the gutter. An empty
  half paints nothing but keeps its column, so a lone pending pill stays
  right and a lone tracker stays left. The halves are bottom-aligned, and
  the row is as tall as the taller half.
- **The row is absent**, with no spacer, when both halves are empty.
- **Height.** One or two pills per half, 44px each and 6px apart: at most
  94px. With three or more, the left half shows the most urgent tracker and
  a summary pill; the right half shows the oldest pending follow-up and a
  summary pill.
- **Pills are 44px, paint and target the same box**, so no paint/target
  exception is needed. Both systems use the same kit pill. A half narrower
  than 240px (at 320 and 390) draws two lines in 44px: the label at 12/600
  in ink, then the state word in mono 10/600 in the state's ink
  (8 + 15 + 13 + 8 = 44px). At 240px or wider it draws one line, with the
  state word right-aligned. The state word never truncates; only the label
  does.
- **A pending pill** prints `pending` in neutral ink, with a `◷` icon, on
  the `neutral` chip ramp: it is waiting, not a problem, so it is neither
  amber nor red, and the word carries the meaning. Tracker pills keep §4's
  words and tones.
- **Labels** are a few words from #1004's small model, falling back to the
  session title or the start of the prompt.
- **The scroll disc** stays inside the message area at `bottom: 16px`, so it
  is at least 16px above the row at every width and never shares its
  centre.

**Keyboard open** (composer focused, soft keyboard up): each populated half
collapses to **one 44px summary**, side by side: `● 3 working`, adding
`· 1 needs you` when the width allows, and `◷ 2 pending` (a single one still
reads `1 pending`). A 32px summary was proposed and is rejected; the summary
is a full 44px row. The budget at 320 × 568 with the keyboard up (visual
viewport about 308px) is: filament 2px, transcript at least 150px, row 44px,
composer 56–112px. **R4:** once the composer passes three lines, the row
hides first, so the transcript keeps at least 150px. Trackers stay reachable
through Sessions, and pending follow-ups through their summary once the
composer shrinks. The tab bar stays under the keyboard, as today.

**Summaries and sheets.** The left summary reads
`+2 more · 1 needs you · 1 done` on one line, or `+2 more` over
`1 needs you` on two, and opens the `Working` BottomSheet. The right summary
reads `+3 pending` and opens a `Pending follow-ups` BottomSheet listing every
queued message in full, in send order, numbered `1 of 4`, read-only.

**A pending follow-up's full text** is a popover above the pill, at most
280px wide and never wider than its half on a phone, with the full prompt
text selectable, `ink` on `raised`. With a pointer it opens on hover or
focus and disappears on leave or blur; on touch a tap opens it, and another
tap, a tap outside or Esc closes it. The text is also always the pill's
`aria-describedby`. It is the row's one hover, and it reveals content, never
state, effect or cost, so D22's hover rule holds. Nothing in it sends,
cancels or navigates.

When the agent takes a follow-up, its pill leaves and the full user message
appears in the transcript at that point in the conversation, in the same
frame and with no animation; a reload shows it once, never twice. If the
half had a summary, the next-oldest pending pill takes the freed place and
the summary's count drops, or the summary goes. A dropped follow-up
(cancelled, revoked or refused) leaves with its reason.

**Focus.**

- Two groups, two tab stops: `role="group"` named `Working sessions` and
  `Pending follow-ups`. Inside each, ←→ / ↑↓ / Home / End rove, and arrows
  never cross the gutter. Tab order is transcript → working sessions →
  pending follow-ups → composer.
- Activating a tracker opens its session (focus per §4). ⏎ or space on a
  pending pill toggles its popover; Esc closes it.
- A summary pill opens its sheet with focus on the first row, and closing
  the sheet returns focus to the summary. A keyboard-open summary blurs the
  composer (the keyboard drops) and opens the sheet; closing it returns
  focus to the composer with the caret restored.
- Each group announces through its own polite live region, so the two never
  interrupt each other. Pending: `Follow-up queued`,
  `Follow-up sent to the agent`, `Follow-up dropped: {reason}`. Trackers
  announce once, politely, when one changes to `needs you`, `failed` or
  `done` (`Tax folder cleanup needs you.`); changes into running or queued
  are not announced.

**Motion.** Nothing in the row or the pane animates, in either mode, and
popovers appear without a transition. D22's one ambient animation stays the
filament.

### 4. Trackers under Recovery A

A tracker is created when a session leaves the foreground with a live run,
a queue entry, a pending interaction or an unconfirmed send, and when work
starts in a session that is not being watched. Leaving an idle session with
nothing pending creates none. It stays until
the session's latest turn is **seen**, as defined below. Selecting a session
acknowledges nothing.

**The stored record holds identifiers only**, under the root's own prefix:
`${storagePrefix}:trackers:v1`, through the root's `storageKey`
(`const prefix = options.storagePrefix`, `packages/ui-react/src/root.ts:180-186`).
There is no global key.

```ts
type TrackerRecord = {
  sessionId: string;
  requestId: string | null; // latest accepted request known when left
  turnId: string | null;    // null while queued
  revision: number | null;  // host accepted-work revision, if known
  leftAt: number;           // client clock; ordering only
  seen: {
    turnId: string;
    revision: number;
    basis: "proof" | "acknowledged"; // R1
  } | null;
};
```

No transcript, title, pending payload or credential is stored; titles come
from the session list at render time. A principal change or a revocation
event deletes the whole set. Draft content never enters this record (§5).

**States, in display order.**

| # | State | Proof | Ink | Pill word | Second line |
| --- | --- | --- | --- | --- | --- |
| 1 | needs you | `pending[]` has an entry for this session | red | `needs you` | `approval` / `question` |
| 2 | failed | terminal, failure outcome | red | `failed` · `interrupted` · `timed out` | `ended 09:41` |
| 3 | unconfirmed | local send with no acceptance proof | amber | `unconfirmed` | `didn't hear back` |
| 4 | running | `latest.state` is `running` | amber | `running · 2m`, from `startedAt` | — |
| 5 | queued | `latest.state` is `queued` | amber, or red with a queue note | `queued` / `queued · busy` | the host's queue note, verbatim |
| 6 | unknown | the host answered, but proof or linkage is missing, or a rollback was detected | ink-mute, dashed ring | `unknown` | `host can't confirm the latest turn` |
| 7 | can't check | the read failed, is unsupported, or the session is missing | ink-mute | `can't check` | `host unreachable` / `host too old` / `session not found` |
| 8 | done | terminal success; a pruned detail with a valid rollup counts | teal | `done · 4m`, from `endedAt` | `finished 09:41` |
| 9 | cancelled | terminal cancelled or denied | ink-mute | `cancelled` / `denied` | `ended 09:02` |

- Order by `#`, then by newest `revision`. `unknown` and `can't check` sort
  above `done` because they may be hiding work.
- Revocation removes `needs you` without naming what was pending, and is
  never shown as a terminal outcome.
- Times come only from the host's `startedAt` / `endedAt`; when those are
  null, no time is printed.
- **`lastActiveAt` and `lastTouched` are never read.** A newer
  `lastActiveAt` can mean that a new turn started
  (`export interface ChatSession`, `packages/ui-sdk/src/protocol.ts:1455-1485`),
  and `lastTouched` is LRU bookkeeping for buffer eviction.

**Merging snapshots and live frames.**

1. Keep the highest `revision` per session; ignore anything lower.
2. A snapshot whose revision is below one already seen from the host is a
   rollback: the tracker becomes `unknown`, never the older state.
3. At equal revision, a given `requestId` only moves forward: queued →
   running → terminal. A terminal state never reverts.
4. A newer accepted request replaces `latest`. A known old success never
   masks newer queued, running or unknown work.
5. Each snapshot replaces `pending[]` whole. It may belong to an earlier
   turn while `latest` is queued.
6. Live frames that arrive during a fetch are buffered and applied after it,
   under rules 1–4.

**Seen.** One observer, keyed on `{sessionId, turnId, revision}`, clears a
tracker only when all of these hold for one committed frame: the session is
active; Chat is in the foreground with no panel or other view over it;
`document.visibilityState` is `visible`; history has a message whose
host-proven `turnId` equals `latest.turnId`; and that message's last line is
in the viewport at the bottom, by the same `< 20px` test the transcript uses
(`const handleScroll`, `packages/ui-react/src/components/chat/chat-page.tsx:264-268`),
with the scroll disc not drawn. An older key never clears a newer tracker.
Selecting the session, being scrolled up, a hidden tab, a background buffer
and the bottom of a replay without the linked turn do not count.

**R1 · An unlinked latest turn.** When history carries no host-proven
`turnId`, nothing can prove the turn was seen. The boundary row then offers
`Mark as seen`. Activating it clears the tracker and stores
`basis: "acknowledged"`: the user's acknowledgement, never proof. Only the
observer above writes `basis: "proof"`.

**Focus on opening a tracked session:** a pending interaction → its card's
first control; a failure → the error card's primary action; otherwise, on a
desktop → the composer with the caret at the end; otherwise, on a phone →
nowhere, so the soft keyboard does not open.

**Retention.** Evicting a transcript buffer (at most eight are held) never
removes a tracker; opening the session reads it again. States 1–7 are
uncapped, because live work bounds them. `done` and `cancelled` are capped
at 24, and the overflow leaves the pill row but keeps an `unseen` word on
its Sessions row. Nothing disappears silently.

**Approval recovery.** When a valid pending approval's `turnId` has no
assistant message (the replay ends on the user's message), the transcript
draws a **turn shell**: the `BRAIN` label at the turn's `startedAt` and the
card, with no invented text. **R3:** a `restored` chip marks a restored
*approval* card only. Its controls stay live only while the envelope's
`pending[]` lists the request; otherwise it is read-only, with one of
`answered on another device`, `ended with the turn` or
`no longer yours to answer`. Rehydration never sends a reply. The four ask
kinds keep #910's rules and state footer, with no second indicator.

> **2026-10-06 — Implemented by #948 (client state; the strip and pane are
> #950).** The model is `packages/ui-react/src/lib/trackers.ts`, the root's
> store is `stores/tracker-state.ts`, the socket and chat wiring is
> `lib/tracker-client.ts` and the observer is `hooks/use-tracker-seen.ts`.
> Four readings of the text above:
>
> - *Leaving the foreground* is selecting another session, New chat, the
>   page's `pagehide`, or the document turning hidden. Switching to Actions
>   or Graph does not leave the session in view, since the seen rule already
>   requires Chat in the foreground.
> - *Work in a session that is not being watched* is a live frame for a
>   session other than the one in view that starts or continues work: a
>   queued status, a turn's `session_info` or progress, an approval or a
>   question. A late `result`, a replay, or a resume's `session_info` that
>   names no turn and no request does not start a tracker.
> - Before any read or frame has answered for a restored tracker it reads
>   `can't check · host unreachable` (or `host too old` without the
>   capability), and its view says it is not yet settled, so #950 can hold
>   announcements until it is.
> - `Mark as seen` with no latest turn identity to store deletes the record,
>   since there is nothing to acknowledge against.

> **2026-10-06 — R3's read-only card and the shell's time, implemented by
> #1072.** The rules are `packages/ui-react/src/lib/restored-approvals.ts`,
> applied by the #948 tracker client, whose recovery read now also covers a
> session that holds a restored card. Only a read that began after the card
> was restored can close it by absence. Readings of the text above:
>
> - `answered on another device`: a `tool_result` arrived while the card was
>   still waiting on this page, or the envelope no longer lists it while the
>   turn that raised it is still `latest`'s running turn. During its turn the
>   host drops a pending approval only on a decision; the turn's end drains
>   the rest.
> - `ended with the turn`: a terminal frame for that turn, an envelope whose
>   latest turn is that turn and is terminal or `unknown`, or is a different
>   turn, or `session not found`.
> - `no longer yours to answer`: a 401/403 read for any session, or a
>   revocation. Every restored card in every buffer takes it and drops its
>   request and turn identities.
> - Absent from `pending[]` with a newer request only queued, or with an
>   unknown latest that names no turn, or in an envelope rejected as a
>   rollback or a contradiction: no fact says why. The controls go and no
>   word is printed until a frame or the next read says which. A closed
>   card's request is settled in the tracker evidence too, and a late
>   duplicate of its request does not reopen it.
> - The shell's header time is `latest.startedAt` when `latest.turnId` is the
>   shell's turn. Otherwise, and without the capability, no time is printed.

> **2026-10-06 — Implemented by #950 (the strip, the pane and the
> announcements).** The pills are `components/chat/composer-row.tsx`; the
> Working group is `SessionList`'s, drawn by the drawer below 1280 and by
> `components/chat/sessions-pane.tsx` from 1280; the root's session list,
> which names every tracker, is `stores/session-list-state.ts`; and which
> changes are announced is `lib/tracker-announcer.ts`. Five readings of the
> text above and of §3:
>
> - Working lists the trackers the pills show. A `done` or `cancelled` past
>   the cap of 24 leaves both, and stays on its date row with `unseen`.
> - `Mark as seen` is offered at the end of the transcript of the session in
>   view when its tracker has settled, nothing is in flight, the state is
>   `done`, `failed`, `cancelled`, `unknown` or `can't check`, and no
>   message carries the latest turn's id. Those are the cases no observation
>   can clear.
> - The words for the other two announced states follow `needs you`'s:
>   `{label} failed.` (`was interrupted.`, `timed out.`) and
>   `{label} is done.` A tracker's first settled view is what was already
>   the case, not a change: one restored on load, taken in from another tab,
>   or made by leaving the session in view announces nothing then. Work that
>   starts in a session nobody is watching announces its first settled view.
>   Changes that arrive together are each announced.
> - Opening a tracker moves focus once the session's replayed history is
>   complete (a chunk has come and none has followed it for 150ms) and, for
>   `needs you`, its card is drawn: 5 seconds at most, then with what is
>   drawn. Going elsewhere first, or opening anything over Chat (a panel,
>   the palette, a subagent view, the mask editor, the handoff sheet),
>   cancels it.
> - From 1280 a Sessions drawer opened by any route, or open when the window
>   widens past 1280, closes and moves focus into the pane, at the selected
>   row.

### 5. Per-session drafts, stored on the host (storage C)

**Identity.** Every composer belongs to
`{draftId, sessionId | null, revision}`, where `draftId` is a client UUID.
There is no shared null-session bucket. Client draft state is root-owned
and separated by host, root and session identity. A saved draft's text and
attachment bytes survive reload, tab close and a normal host restart, and
restore on any of the same operator's authorized devices at that host. Navigation restores by `draftId`:
selecting a session, switching destinations, opening panels and remounting
the composer. Actions and Graph unmount the composer today, which is the
loss #942 measured; view unmount and buffer eviction never touch the draft
store. Composer keystrokes stay isolated from transcript rendering, and
reading a session or its history never submits its draft. A D50 chip still
fills the composer below the reader's text, which is now that session's
draft.

**New chat**, from every entry point (the overlay disc, Sessions
`New conversation`, the palette row and the ≥1280 pane button), saves the
current draft and opens a fresh identity with an empty composer. There is
no discard confirmation, because nothing is lost. A fresh identity is not
stored until it has content, so repeated empty New chats leave nothing
behind. Host session acceptance binds only the matching original draft.

**Draft entries in Sessions.**

| Row | Title | Trailing | Subtitle | Accessible name |
| --- | --- | --- | --- | --- |
| Unbound, with text | first line of the text | `draft` | save state | `Draft: {title}, {state}. Open draft.` |
| Unbound, images only | `Draft with 2 images` | `draft` | save state | same |
| Bound | session title | `draft · 2h` | unchanged | `{title}, has a draft. Open session.` |

Opening an unbound draft opens an empty Chat with that draft restored.
Nothing is sent and no host session is created.

**Save state**, printed under the composer while a draft exists.

| State | Copy | Rule |
| --- | --- | --- |
| saving | `draft · saving…` | a PUT is in flight; shown after 600ms |
| saved | `draft · saved` | only after the host acknowledges this exact revision, attachments included |
| unsaved | `draft · not saved yet` | dirty and offline, or a transient refusal; retried with backoff |
| conflict | `draft changed on another device · Compare` | see below |
| unavailable | `draft · this host doesn't keep drafts · kept on this device` | capability absent |
| too large | `draft · too large to save (8 MB max) · kept on this device` | 413 |
| full | `draft · 100 drafts saved · delete one to save this` | 507 |

Content is always kept locally and is never dropped to fit a limit. Nothing
claims host durability for an unacknowledged save.

**Conflict.** `Compare drafts` shows this device's and the other device's
version with their edit times, and offers `Keep this device's`,
`Keep other's` and `Keep both`. Keep both turns the other version into an
unbound Draft entry. There is no automatic or model merge, and a host
refresh never overwrites dirty visible content: it raises the conflict
instead.

**Delete, attachments and consumption.** Emptying the composer (all text and
every attachment) deletes the draft at its current revision and leaves a
host tombstone. There is no confirmation, because only the user's own action
removed the content. Removing one attachment chip removes only that
attachment, in the next revision. An accepted send consumes exactly the
submitted revision; edits made after submitting become the next revision
and stay.

**Sends are separate from the editable draft.** A send is an immutable
snapshot. Late `session_info`, results or receipts for A settle only A's
request and its submitted attachments: they never select A after
navigation, adopt B's draft, clear newer edits or consume another draft's
images. A send without acceptance proof stays in place as a review block
with three controls. `Check again` reads the recovery envelope: accepted
becomes a normal turn, not accepted keeps the block, and can't check
changes nothing. `Send again` sends with a new Idempotency-Key. `Edit` puts
the text and images back into the draft. Nothing is resent automatically,
and leaving the session gives it an `unconfirmed` tracker.

**Authority.** Saving, restoring, listing, deleting, binding and consuming a
draft are authenticated data operations. None grants permission to send,
reply or start a model turn, and none answers a question; #910's
question-answer rules are independent.

> **2026-10-06 — Implemented by #951.** The root's draft store is
> `packages/ui-react/src/stores/draft-state.ts`, the host sync and the send
> settlement are `lib/draft-client.ts` over `lib/draft-api.ts`, the words
> are `lib/drafts.ts`, the line under the composer and `Compare drafts` are
> `components/chat/draft-save-line.tsx`, and the review block is
> `components/chat/unconfirmed-sends.tsx`. Readings of the text above:
>
> - *Kept on this device* means kept by this page's root, in memory. A
>   draft survives a reload only through the host; device storage across a
>   reload is #1014's, keyed by this store's draft identity. So a service
>   worker update waits while any draft holds words the host has not
>   acknowledged, or any send is unsettled.
> - The field empties when a message is sent: the send is the snapshot, and
>   the host keeps the revision it names until it accepts the message. The
>   message names a revision only when the host acknowledged exactly what
>   is sent. A refused message's text and images go back into its draft,
>   ahead of anything typed since; Edit does the same for a held one.
> - A `410` for a draft this page's own accepted send consumed keeps the
>   newer content in that session, under a new id; any other `410` makes it
>   a new unbound draft, as above. A second host draft for a session that
>   already keeps one here is a conflict on it (`Keep other's` takes the
>   other draft, `Keep both` makes it a Draft entry), never a switch.
> - While a save is out for under 600ms, or a dirty draft has not been sent
>   yet, the line prints nothing; a Draft entry then reads `not saved yet`.
>   `too large` prints the bound the host named (`8 MB`, `64 KB`, `4
>   images`), and `full` its count or bytes.
> - A new conversation whose first message is still unanswered when the
>   reader leaves it keeps its transcript aside; its `session_info` makes it
>   that session's buffer without selecting it, and its draft that
>   session's draft.
> - The review block's reason reads `The connection dropped before the host
>   confirmed it got this.`, or, for a refusal that named no request, `The
>   host refused a message without saying which, so it may not have got
>   this.` The envelope names only the latest request, so `Check again`
>   finds a held send accepted only when it is that request; a different
>   latest proves neither, and it prints `Can't check · the host's latest is
>   another message`. Other reasons follow §6's rows; a first message has no
>   session to read, so its reason is `no session yet`. Send again sends the same snapshot under a new request
>   id, naming the revision only while the host still holds it.
> - Track files are uploads staged for a message, not draft content: they
>   stay with their session (or new chat) on this page, in the field until
>   the host accepts the message that carries them, and are not saved to
>   the host.
> - A new chat's unconfirmed first message has no session to be found in,
>   so its review block is held in the new-chat view whichever new chat is
>   open; Send again and Edit first open that message's own new chat, as New
>   chat does. Until it is resolved, that new chat sends nothing else, since
>   a second first message would start a second conversation beside it.
> - In empty Chat the pane's `New conversation` stays `aria-disabled` (§2);
>   a nonempty new-chat draft reaches a fresh one through the palette row.

> **2026-10-08 — Track-only drafts, implemented by #1112.** The design
> approved on #1112: a new chat whose staged-track queue holds a track is a
> Draft entry even with no text or images, `Draft with 1 track file`
> (`Draft with 2 images, 1 track file` beside images), with the state line
> `draft · tracks in this tab only`, or `draft · {save word} · tracks in
> this tab only` in a mixed draft. `1 track failed` comes before `uploading
> 1 track`, which comes before the lifetime words; tracks are never called
> saved. Opening it shows that new chat's queue again and sends nothing;
> removing its last track, with no text or images left, takes it out of
> Drafts and focuses the field. While the new chat holds a staged track,
> the pane's `New conversation` is not `aria-disabled`. The words are
> `trackStateWord` and `draftEntries` in `lib/drafts.ts`; the queues are
> watched as one by `subscribeAllTracks` in `lib/draft-tracks.ts`, which
> the service-worker update also waits on: any root-owned queue holding a
> track, in any view, is unsaved work.

> **2026-10-07 — Leaving the page with staged tracks, implemented by
> #1150.** While any root-owned queue holds a track, in any view and any
> upload state, the root's track registry registers a `beforeunload`
> handler, so a manual reload, closing the tab or navigating away asks the
> browser's own leave confirmation. The browser draws its own words; there
> is no custom text and no in-app sheet. The handler moves with the same
> change notice that drives `subscribeAllTracks`, is removed when the last
> track is sent or removed (or the root is disposed), and is updated before
> any watcher hears the change, so the update takeover's reload after the
> last track goes never asks. It belongs to the root rather than a mounted
> component, so it holds while the login gate replaces the app; a scripted
> reload that would lose tracks, such as the one after signing in, asks as
> well. Browsers may skip the prompt on a page the user never interacted
> with; Chromium under test automation asks regardless. The guard is
> `guardLeaving` in `lib/draft-tracks.ts`.

> **2026-10-07 — Drafts kept on this device across a reload, implemented by
> #1014.** Every draft in the root's store, with its images, and the work
> context around it (the voice review text, the uploaded tracks of the view
> by reference, the selection, the focused element and the first transcript
> message in view with its offset) are written to IndexedDB a moment after
> each change, in the signed-in account's partition. The partition is named
> by the host's `accountKey` on `/api/vpn-check`, which every sign-in as the
> same owner shares (the
> [contract](../integration-contract.md#account-partition-key-additive-1014)
> has the table per auth mode); the client opens it only while it holds that
> key, and never writes one account's work into another's. After an
> authenticated boot as the same account the drafts come back first, before
> the host's list is read, so a host version meets them as it would meet
> the page that wrote them; then the selection and focus, then the
> transcript's place. *Kept on this device* now holds across a reload. A
> write the browser refuses (quota, private mode, no storage) puts `Couldn't
> save your draft on this device.` in the composer's hint and takes the words
> `kept on this device` off the save line until a write succeeds; editing
> goes on in memory. The store asks once for persistent storage and promises
> nothing from the answer. Staged tracks keep #1112's lifetime: their
> references are in the snapshot, and a reload does not bring the queue back.
> This is not encryption and not protection against someone with access to
> the device. The modules are `lib/local-partitions.ts` (the partition
> primitive) and `lib/local-work.ts` (the snapshot, and `snapshotNow`, which
> resolves only once its transaction has committed).

**Device-local conflicts — maintainer ruling, 2026-10-07 (#1208).**
Two tabs of the same account/root share device storage. Their expected
per-record revision is checked inside the native IndexedDB write transaction.
A divergent stale write keeps the already-committed draft under its original
draft/session identity and atomically stores the incoming text and image bytes
as a new unbound Draft entry. The stale writer keeps its visible text,
selection and navigation, and subsequent edits follow its branch. A local
view association can show that branch while the original session remains
selected; it never binds the branch to that session. Each tab keeps its own
reload context, while draft records remain shared and account-partitioned.

Only after transaction commit does the stale writer show
`Another tab changed this draft · Both versions kept`, with `Open other version`.
Both versions remain reachable through the draft/session surfaces after a
reload, including a fresh third tab. A failed write leaves editable content
in memory and uses the existing storage-failure copy; it makes no retention
claim. Stale emptying, deletion and send consumption cannot erase another
tab's committed version. Empty revision tombstones fence stale resurrection;
immutable send snapshots remain separate from editable draft identities.
Pending sends retain their branch target even when the reader opens the
original, and Edit follows that target. A live tab claims its context identity
with a browser lock so a duplicated tab with copied session storage receives
a distinct identity while an ordinary reload resumes its own context.
Recording acceptance commits its retained branch and receipt before deleting
its audio. Host conflicts still use the explicit Compare policy above.

Rejected: last writer wins loses committed work; refusing the stale write
alone leaves its incoming version undurable; keeping the incoming version
under the original identity silently changes the original session's owner;
automatic/model merging is unauthorized. Repeated branches for one divergence
are avoided by retargeting the stale writer after the first committed fork.

### 6. Host contracts the implementations add

These are the technical outputs Recovery A and storage C asked #943 to fix.
They are **not shipped**. Each lands with its SDK schema, the HTTP
reference, a same-commit `docs/integration-contract.md` update, a
`CONTRACT:` commit and minor changesets: recovery in #964, drafts in #979.

**Recovery (#964).** Clients use it only when `server_hello.capabilities`
advertises `sessionRecovery: true`. Without it, restored trackers read
`can't check · host too old` until live frames prove otherwise.
`GET /api/sessions/:id/recovery` returns:

```ts
{
  sessionId: string;
  backendId: string | null;
  revision: number; // persisted, host-owned accepted-work ordering
  latest: {
    requestId: string | null;
    turnId: string | null; // null until a queued request is dispatched
    state: "queued" | "running" | "terminal" | "unknown";
    outcome: ActivitySpanOutcome | null; // the existing Activity vocabulary
    startedAt: number | null;
    endedAt: number | null;
  };
  pending: Array<{
    kind: "approval" | "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
    requestId: string;
    turnId: string;
  }>;
}
```

History messages gain an optional `turnId`, present only when the host can
prove it and never inferred from timestamps or content. `revision` orders
acceptance, not backend mtime, message count or identifier comparison.
`pending` lists live, authorized original identities; it is neither a
transcript nor a grant, and its payloads rehydrate through the existing
scoped interaction frames. Authorization is rechecked after every
asynchronous step.

The host correlates request, turn, session and backend identities from its
actual acceptance, coordinator, catalog and Activity records; uncorrelated
imported history gets no fabricated identity. `startedAt` / `endedAt` are
real host run times. Losing process-local execution or pending maps does
not resurrect them, and a retained acceptance receipt proves acceptance, not
continued execution or the completion of an external effect. A recovery
read never selects a session, starts work, replies or grants anything.

| Response | Client state |
| --- | --- |
| 200 envelope | §4's rules |
| 401 / 403 (the existing auth envelope, with no identities) | `can't check`; `needs you` is dropped |
| 404 `SESSION_NOT_FOUND` | `can't check · session not found` |
| 404 route (capability set, route missing) | `can't check · host too old` |
| 5xx or network failure | `can't check · host unreachable`; retried on reconnect |

An internal failure is never a 200 `unknown`: `unknown` means the read
succeeded and proof is absent.

**Drafts (#979).** The capability carries the **R2** limits:

```ts
server_hello.capabilities.sessionDrafts = {
  maxTextBytes: 65536,      // 64 KB of text
  maxDraftBytes: 8388608,   // 8 MB per draft, attachments included
  maxDrafts: 100,
  maxTotalBytes: 268435456, // 256 MB per host
};
```

```text
GET    /api/drafts                       → { drafts: DraftSummary[] }
         DraftSummary: draftId, sessionId|null, revision, updatedAt, preview, attachmentCount
GET    /api/drafts/:draftId              → Draft: text, attachments[{attachmentId, mime, bytes, name}]
PUT    /api/drafts/:draftId              If-Match: <revision|0>, Idempotency-Key
       { sessionId: string|null, text, attachmentIds[] } → { revision, updatedAt }
POST   /api/drafts/:draftId/attachments  Idempotency-Key, bytes → { attachmentId }
DELETE /api/drafts/:draftId              If-Match: <revision> → 204, writes a tombstone
POST   /api/drafts/:draftId/bind         { sessionId, requestId } → { revision }
```

`chat_message` gains an optional `draftRef: { draftId, revision }`. When the
host accepts the message, it deletes the draft only if that revision is
still current. Errors use the existing envelope: 409 `DRAFT_CONFLICT` with
`{ current }`; 410 `DRAFT_DELETED` with `{ tombstoneRevision }`, after which
the local content becomes a new unbound draft; and 413 `DRAFT_TOO_LARGE` and
507 `DRAFT_CAPACITY`, each with `{ limit }`. Tombstones stop stale autosaves
and late receipts from resurrecting a removed revision. The existing image
bounds still apply to each attachment, alongside these aggregate limits.
The namespace is the existing single-owner host model, not partitioned by
temporary device-login principal: every call resolves and attributes the
current principal and honours revocation, with no new role and no
cross-root access. Drafts and their attachment bytes live in the
operational store, inside the generic backup set, and never in `brain.db`,
canonical Markdown or the tracker record.

> **2026-10-06 — Implemented by #979, with one placement change.** The
> limits object above travels as `server_hello.sessionDraftLimits`, beside
> `capabilities.sessionDrafts: true`, not inside `capabilities`: every
> shipped client validates `capabilities` as a string-to-boolean record and
> would drop the whole hello over an object value, which an additive change
> may not cause. The routes also answer 404 `DRAFT_NOT_FOUND`, 400
> `DRAFT_INVALID`, 428 `DRAFT_PRECONDITION_REQUIRED`, 409 `DRAFT_KEY_REUSED`
> (one key, a different request) and 409 `DRAFT_NOT_ACCEPTED` (a bind without
> an accepted first message), and 413/507 bodies name their `bound`. The
> [integration contract](../integration-contract.md#session-drafts-additive-979)
> is the reference.

### 7. What the kit gains

Read from the source, not inferred from the drawings:

- `SideRail` has no act or palette props, and its ⌘K cap is a passive
  element. Rail acts and a clickable All commands are **new** kit props
  (#944).
- `ListRow`'s `card` row is about 43px tall and there is no `density` prop;
  the 44px pill is a **new** `density="pill"` (#949).
- A `SuggestionChips` chip is about 31px, with no `disabled`, `why` or
  `cost`. Those props are **new**, and chips get a 44px minimum under a
  coarse pointer (#945).
- The scroll-to-bottom disc is a bare 32px button with only a `title`
  (`{showScrollButton && (`, `packages/ui-react/src/components/chat/chat-page.tsx:723-731`).
  It has no 44px box and no accessible name, so it joins `DiscButton`.
- **`DiscButton`** is a 32px paint in a 44px box, with `tone: ink | mute`
  and an optional label that expands leftward. It draws exactly three
  discs: the phone Search disc, New chat below 1280
  (`{hasMessages && !wide && (`, `packages/ui-react/src/components/chat/chat-page.tsx:647-654`)
  and scroll-to-latest. It is not used for rail rows, pills or chips. Both
  overlay boxes share one vertical range, so #628's resting spacer (`pt-10`
  below an 888px container, not the 880px in the drawings) still clears
  them, and #779's geometry work is untouched.
- **The shared row** is one kit container owned by #949: the grid, the half
  boxes, the width-based pill layout and the keyboard-open summaries. #950
  wires the left half; #1002 fills the right half and adds the
  `Pending follow-ups` sheet and the popover. One kit story covers the
  combined row at 320, 390 and 900 with both halves populated, one half
  empty, and the keyboard up.

### 8. What carries over from the supplied designs

The supplied [navigation design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973564827)
and [parallel-session design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973572791)
hold the full drawings and still bind where §§1–7 do not replace them.
Their binding rules:

**Placement of future acts.** Each act has a frequency class (S, D, O) and
an effect (none, writes, spends).

- **V1** S acts get a persistent visible control at every width, one
  activation from Chat.
- **V2** D acts get a persistent visible control wherever it can show the
  act's name and effect at rest. Where it cannot, they move one step down
  for that width: All commands on the rail, More on a phone.
- **V3** O acts get no persistent control: a palette row on desktop and
  tablet, a More row on a phone. Palette-only is allowed only because the
  palette has a visible button.
- **V4** Acts never take a destination slot or join the destination
  tablist (D37 §1: a tab is a place).
- **V5** is replaced by §1's placement-only cap.
- **V6** A control that cannot show the effect at rest is not drawn for that
  act, and the effect never moves to a hover (D22).
- **V7** Within a section, order by class, then effect-free first, then
  alphabetically.

The §2 exceptions stand over V1 and V2 as adopted. A place keeps its slot by
being a place: Files keeps slot 4 although it is O, and a future place used
more often than Files would take the slot and move Files to More.

**The rail.**

- Act rows use the destination row's geometry: at least 36px tall (44px
  under a coarse pointer), a 17px icon and a 12.5px label, in `inkMute`,
  never amber, because an act is never "here". Activating an act does not
  move the amber destination, except that it lands in Chat as the
  palette's `inChat` does.
- A disabled rail briefing keeps its chip; its reason is a second line in
  9.5px mono.
- Collapsed, effect-free acts are icons with accessible names and **no
  tooltip**, like the collapsed destinations.
- In a short viewport the rail's middle, from the destinations through the
  acts, scrolls; the wordmark and All commands stay pinned.
- Palette rows do not print where their visible control lives.

**Phone discs.** The Search disc sits left of New chat with its icon in
`inkMute`; New chat keeps ink at rest as the primary. Both sit in one
right-anchored row, so a label expanding leftward pushes Search and they
never overlap. The Search disc is drawn only below `tablet:` and only while
the chat has messages; the empty state has its chips instead. The New chat
disc is drawn in occupied Chat at every width below 1280 (§1).

**Keyboard and focus.**

- The desktop rail is three tab stops: the destinations (a tablist, ↑↓ /
  Home / End, manual activation); the acts (`role="toolbar"`,
  `aria-orientation="vertical"`, `aria-label="Acts"`, roving with ↑↓ /
  Home / End, ⏎ and space activate, and arrows never cross into the
  destinations); and All commands. Then list → detail → composer (D22).
- On the phone, the overlay's Search then New chat come first in DOM order,
  then the transcript, the composer and the bar. More moves focus to its
  first row on open and back to its slot on close.
- No new keys. All commands prints `⌘K` everywhere, the one rail key not
  gated on a fine pointer (D36 addendum); the destination chords keep
  their pointer-gated printing.
- Search and Add move focus to the panel they open. The briefing and Sync
  leave focus on the composer, and the result arrives in the transcript.

**The Sessions pane (≥1280).** In Chat the list pane is Sessions, 280px
wide. Working pins the trackers in §4's order, each a two-line `ListRow`
with the title and then the state word. The existing date groups follow,
unchanged; the single `Session running…` row goes, because Working replaces
it, and a tracked session does not appear again in its date group. The pane
is two tab stops: `New conversation`, then one roving list (↑↓ / Home /
End) across Working and the date groups. The order is rail → pane →
transcript → composer.

**Actions** is not made the cross-session working queue here; that touches
#684's internals and is a separate design. Its badge still counts pending
approvals across all buffers.

**Drawing, 320, occupied Chat with trackers and pending follow-ups.**

```text
┌──────────────────────────────────────┐
│ BRAIN ───────────────────── 09:41    │
│ The receipts for March are in …      │
│                ┌──┐                  │
│                │↓ │                  │  scroll disc, ≥16px above the row
│                └──┘                  │
│ ┌────────────────┐ ┌────────────────┐│
│ │! Tax folder cl…│ │◷ Also the Apri…││  44
│ │  needs you     │ │  pending       ││
│ └────────────────┘ └────────────────┘│
│ ┌────────────────┐ ┌────────────────┐│
│ │+2 more         │ │+2 pending    ▸ ││  44  (row = 94)
│ │  1 done        │ │                ││
│ └────────────────┘ └────────────────┘│
│ [+] Ask anything…            [◖] [↑] │
├──────┬──────┬──────┬──────┬──────────┤
│◆Chat │◷Sessn│✓Actns│▦Files│ ⋯More    │
└──────┴──────┴──────┴──────┴──────────┘
```

**Drawing, 320 × 568, keyboard up.**

```text
│ …the receipts for March are in      │
│                ┌──┐                 │
│                │↓ │                 │
│                └──┘                 │
│ ┌───────────────┐ ┌───────────────┐ │
│ │● 3 working  ▸ │ │◷ 2 pending  ▸ │ │  44, two separate buttons
│ └───────────────┘ └───────────────┘ │
│ [+] Can you also check the Ap| [◖][↑]│
│ ┌ keyboard ─────────────────────────┐│
```

**Drawing, 900, expanded rail, Files open.**

```text
┌──────────────────────┬───────────────────────────────────────────────┐
│ ▌◆ Chat          ⌘1  │ ┌ Files ───────────────────────[Close files] ┐│
│  ◷ Sessions      ⌘2  │ │ life/ …                                    ││
│  ✓ Actions   (2) ⌘3  │ └────────────────────────────────────────────┘│
│  ▦ Files         ⌘4  │  rail Actions → 1 activation, Files closes    │
│  ⚙ Settings      ⌘5  │  Esc → focus back to rail Files               │
│ ──────────────────── │                                               │
│  ⌕ Search            │                                               │
│  + Add a note        │                                               │
│  ☀ Daily briefing spends                                             │
│ ──────────────────── │  ◐ Trip packing list   running · 2m           │
│ [⌘K] All commands    │  [+] Ask anything…                [◖] [↑]     │
└──────────────────────┴───────────────────────────────────────────────┘
```

**Drawing, 1440, Chat with the Sessions pane.**

```text
┌──────────────────────┬────────────────────────────┬──────────────────────────────────────┐
│ ▌◆ Chat          ⌘1  │ [✎ New conversation]       │  YOU ──────────────────── 09:41      │
│  ◷ Sessions      ⌘2  │ WORKING                    │   Which receipts are still missing?  │
│  ✓ Actions   (2) ⌘3  │ ! Tax folder cleanup       │  BRAIN ────────────────── 09:41      │
│  ▦ Files         ⌘4  │   needs you                │  The receipts for March are in …     │
│  ⚙ Settings      ⌘5  │ ◐ Trip packing list        │                                      │
│ ──────────────────── │   running · 2m             │      (left half empty) ┌──────────┐  │
│  ⌕ Search            │ TODAY                      │                        │◷ Check A…│  │
│  + Add a note        │ ▌Receipts for March     ●  │                        │  pending │  │
│  ☀ Daily briefing spends Weekly review    2h ago   │                        └──────────┘  │
│ ──────────────────── │ YESTERDAY                  │  [+] Ask anything…        [◖] [↑]    │
│ [⌘K] All commands    │  …                         │                                      │
└──────────────────────┴────────────────────────────┴──────────────────────────────────────┘
       208                       280                       remainder (720 measure)
```

The remaining widths and states (empty Chat after New chat, Actions at 480,
the Working sheet, Drafts, conflict and the unconfirmed send) are drawn in
the six #943 design comments linked above.

### Rejected

- **Restoring one activation from anywhere** for every daily act by adding
  controls. The maintainer adopted the supplied exceptions instead (§2).
- **A 32px keyboard-open summary**, or a 32px paint in a 44px target. A full
  44px row needs neither measured separation nor an exception.
- **`lastActiveAt > leftAt → done`.** A newer timestamp also accompanies a
  new running turn, as #942 measured.
- **Recovery from the existing contract only.** It cannot tell done from a
  new turn, or recover a pending approval after reload. Declined for
  Recovery A.
- **No control for an unlinked turn** (R1's alternative), which would leave
  the tracker in place until a linked turn arrives.
- **A draft-discard confirmation, and a streaming-only New chat
  confirmation.** Per-session drafts lose nothing, so there is nothing to
  confirm.
- **Device-local draft storage, and drafts kept only while the application
  runs.** Declined for storage C.
- **A `restored` chip on the four ask kinds** (R3): #910's footer already
  states their state.

### Verification the implementations owe

Keyless Chromium on the public Odysseus fixtures, in both themes, with real
clicks and taps and no forced clicks:

1. Every cell of §2's matrix at 320, 390, 480, 900, 1280 and 1440, recording
   the resulting view, panel and `document.activeElement`. With Files open
   at 390, Actions is one tap, and Esc from Files focuses the Files tab.
   Pressing Sessions again keeps the selection, the draft and the tracker
   count.
2. The shared row at 320, 390, 480, 900 and 1279, with 0–5 trackers and 0–5
   pending follow-ups, keyboard up and down: the halves never intersect,
   the gutter is at least 8px, each half stays in its column, the scroll
   disc is at least 16px above the row, the row is at most 94px (44px with
   the keyboard up), every pill is a 44px target and the state word fits.
   At 320 × 568 with four composer lines, the row is hidden and the
   transcript is at least 150px. At 1280 and 1440 the row shows pending
   follow-ups only. `getAnimations()` is empty for the row and the pane.
3. One recovery fixture per state and per error row, each showing its exact
   word. A rollback snapshot shows `unknown`; a newer queued request over an
   old success shows `queued`. A stale `{T1, r3}` observer does not clear a
   tracker at `{T2, r4}`, and neither does a hidden document or a scrolled-up
   transcript.
4. A cold reload with a pending approval and history ending on the user's
   message draws the turn shell with `restored`. After revocation the card
   is read-only and no reply frame is sent.
5. Text and an image in A → New chat → type → select A: A's text and image
   return, the new draft is listed under Drafts, and a repeated empty New
   chat adds nothing. Visiting Actions and returning restores the draft.
   `draft · saved` appears only after a 200 for that revision. A 409 shows
   both versions, and Keep both creates an unbound entry. With the socket
   closed after a send, the review block appears, and no second
   `chat_message` is sent without `Send again`.
6. Three pending follow-ups render the oldest plus `+2 pending`, and the
   sheet lists all three in send order, in full. The full text is reachable
   by hover, by tap, by focus plus ⏎ and through `aria-describedby`, and
   none of these sends, cancels or navigates. Handing a follow-up over
   removes its pill and adds exactly one user message in the same render,
   with no duplicate after a reload. Tab reaches working sessions, then
   pending follow-ups, then the composer, and arrows never cross the
   gutter.
7. Every new control has an accessible name and a 44×44 target under a
   coarse pointer, in both themes, with coarse, fine and mixed pointers,
   short viewports and reduced motion covered.

A restored mutation of each guard must fail on the assertion named for it.

### D52 addendum — what N3 means for each destination (maintainer, 2026-10-06)

**Sources.** The [design brief](https://github.com/schlessera/brain-kit/issues/1078#issuecomment-6015609270)
on #1078, with two maintainer rulings made during that design pass:
**Chat's start is its latest turn**, and **on a phone, focus stays on the
Chat tab** unless an approval, a question or an error card is waiting, so the
soft keyboard does not open (as §4's tracker rule sends phone focus nowhere).

**N3 as amended.** Pressing the current destination scrolls it to its start
and moves focus: in Sessions to the first Working row, otherwise to the
selected row, or to the destination's heading when nothing is selected. In
Chat, the start is the latest turn: the press does what `Scroll to latest`
does. Focus goes to a waiting card's first control, then a failed turn's
primary action, then the composer; on a phone, focus stays on the Chat tab.
Every scroll is instant. At ≥1280 Sessions is a pane, not the current
destination, and keeps the 1280 row. It never clears a selection, a draft, a
tracker, an open detail or an open file.

**One algorithm.** *Reset*: every scroll container the destination owns goes
to its start, the top except Chat's transcript, and nothing closes. *Resolve*:
the first target in the table below that is drawn. *Reveal*:
`focus({ preventScroll: true })`, then `scrollIntoView({ block: "nearest" })`,
so a target already at the start moves nothing. A press by chord asks for a
visible ring (`focusVisible`), because Chromium does not count a modifier
chord as keyboard input for `:focus-visible`; a tap shows none.

| Destination | Width | Reset | Focus, first match |
| --- | --- | --- | --- |
| Chat, occupied | phone | transcript → latest turn, same window | waiting approval or question → its first control · the latest turn's failure → its primary action · else stays on the Chat tab |
| | 480 up | same | same, then the composer, caret at the end |
| Chat, empty | phone | welcome → top | a waiting card · else stays on the tab |
| | 480 up | welcome → top | the composer, caret at the end · the welcome heading if it cannot take focus |
| Sessions | every width until #950 | drawer body and list → top | the reattachable running session (the Working row until #950's group exists) · the session in view (`aria-current`) · the first row · the "Sessions" heading |
| Actions, list | below 900 | list → top | the "Actions" heading |
| Actions, detail open | below 900 | detail → top; it stays open | the detail's heading · the "Actions" heading |
| Actions | 900 up | list, detail and evidence rail → top | the selected row (run rows carry `aria-current`) · the "Actions" heading |
| Files | below 900 | viewer and tree box → top; a sandboxed HTML preview, whose scroll the panel cannot reach, loads its source again | the open file's tree row, when the tree is shown · the reading pane's title · the "Files" heading |
| | 900 up | reading pane (an HTML preview as below 900), tree and evidence rail → top | the open file's tree row · the "Files" heading |
| Settings | every width | drawer body, or the pane's section scroller → top | the selected section tab |

A chord still reaches a destination behind an open modal, such as the
one-time credential dialog, but the press never moves focus out of the
modal. Headings are script-only stops (`tabIndex=-1`) that Tab never reaches; they
draw the kit's 2px ink ring at −2 on `:focus-visible`. The press changes no
view, panel, Settings section, session, run selection, file, tree visibility
or draft, so the Settings leave guard has nothing to ask. A Chat press can
bring the latest turn into view and let §4's seen observer clear that
session's tracker: proof the turn was seen, not a clear performed by the
press. D36 is unchanged: no key is added, and focusing a list row or a card
makes its own keys live as a Tab to it would.

**Where it lives.** The store records a press of the destination already
shown, with no DOM (`pressDestination`,
`packages/ui-react/src/stores/ui-state.ts:248-259`). The mounted destination
answers it (`useDestinationPress`,
`packages/ui-react/src/hooks/use-destination-press.ts:18-33`) with the shared
reveal (`focusFirst`, `packages/ui-react/src/lib/destination-start.ts:46-58`).
The cells are `packages/ui-react/tests/browser/destination-press.pointer.tsx`,
run in the kit's `rail-fine`, `rail-coarse` and `rail-mixed` projects.

> **2026-10-06 — #950's Working group exists.** Below 1280 the Sessions row
> of the table now starts at the first Working row, then the session in
> view, the first row and the heading; the single reattachable row is gone.
> From 1280 the press keeps the 1280 row: Chat stays the destination and
> focus moves into the pane at the selected row.

## 2026-10-07 — D53: loading is ghost text (#1116)

**Decision.** A loading state is **ghost text**: blurred text set in the same
type role, size and length as the content it stands in for, with the kit
spectrum (amber → purple → blue) sweeping through it left to right. When an
item's data resolves, its ghost cross-fades out under the real text over
600ms. The amber `breathe` skeleton bars are gone from every loading view.
`GhostText` is the only thing that draws a ghost (`ghostString`,
`packages/ui-kit/src/internal/GhostText.tsx:99-116`).

**Why it beat the alternatives.** Grey bars with the amber halo read as a
glowing outline, and they had the shape of no content in particular, so the
layout jumped when the content arrived. The design explored two other answers:
an aurora field behind the card, and "decode" noise that resolves into the
text. The aurora field has no shape at all and says nothing about what is
coming. Decode noise is legible glyph churn: it animates the text itself, reads
as content, and cannot honour reduced motion without becoming a frozen
nonsense string. Ghost text has the replaced content's own shape, so the frame
is final from the first frame and, when the ghost knows what it stands in
for, the handoff moves nothing.

**Length-sized ghosts.** A ghost is as long as what it replaces: the value
this item showed last time on a re-fetch, else a length hint the caller has (a
search snippet's length, a file name from a listing), else the component's
typical length (an ActionCard title 58 characters, a body 44, a queue subject
22, a search path 26 and snippet 120, a file name 14, an answer three lines of
the measure). The glyphs are seeded words of 2–9 characters at roughly English
letter frequency, seeded by the component instance — which React keeps per
item key, not per list position — so they never flicker and re-ranking a row
does not regenerate them. A single-line
slot matches its ready line exactly. A wrapping slot can still break onto one
line more or fewer than the real text, because seeded words do not break
where the real ones do; a sweep of the fixture strings at 110–380px measured
that in about one case in eight. That is the cost of not drawing the stale
value, and it is accepted. So is the cold load: with no history and no hint,
an ActionCard ghosts a typical card — kind, title, body and foot — and a
title-only card loses those two bands when it arrives.

**Paper hues tuned for contrast.** All three hues stay on paper, deepened
along their own hue until each contrasts with the paper ghost base (`#c8bfac`)
as much as its dark pair does with the dark base (`#3a3d46`): amber 4.75,
purple 4.26, blue 4.93. Those are derived values, not drawn ones, and
`tests/ghost-text.test.tsx` holds each pair within 10%.

**Ghost text is a loading state, not ambient motion.** D22's "one ambient
animation" keeps its wording: `breathe` is still the only thing that moves on
its own for as long as a state lasts. A ghost moves only while something is
being waited for and ends when the data does, which is the line between the
two. `ghost` is therefore a second keyframe beside `breathe`, not a second
ambient one. Reduced motion shows the ghost as plain blurred text in the base
colour, with no sweep and no spectrum, makes the handoff instant and lands a
stream's tail at once; print hides it. `tests/visual/ghost-media.visual.tsx`
checks the computed result under the emulated media, so a rule that wins the
cascade back cannot pass it.

**What is never ghosted.** The frame — borders, radii, padding, icons, the
status-dot slot — is final from the first frame. Emphasis that depends on the
data waits for it: an approval's 2px border, a blocked row's amber shell, a
dot's tone. An icon that depends on the data is a 14px outline slot until then.
Slots the caller already passes while loading — an ActionCard's chip,
machine facts, children or foot link, a queue row's note and link — keep their
space: the text ones as ghosts, the rest invisible and inert. A streaming
answer's first chunk fades in over the same 600ms, and it holds
its ghost's height while it streams, so the first token, shorter than the
ghost, moves nothing below it; past that height the answer grows downward.
Nothing is a control while it loads: no role, no tab stop, and a click does
nothing.


### D53 addendum — one compositor band per frame (#1126, 2026-10-07)

**Decision.** The maintainer selected V5 after reviewing V1–V4: static base
text, with one moving band for each QueueItemRow, FileRow, SearchResultCard,
ActionCard and Placeholder frame, or StreamingAnswer prose block. This replaces
per-slot sweeps and per-row staggering; each item still hands off when its own
data arrives, over the same 600ms. The retained `index` props no longer set a
sweep delay. Neither the seeded glyphs nor their role/size/blur map changes.

**Why.** V1 moved `background-position` through clipped, blurred text, repainting
and blurring every slot each frame. V3 moved a band per line but multiplied the
compositor work. V5 shares the moving mask across the block. The prototype
measurements on Chromium 153, at 6× CPU throttle, 412×915 and 2.625 DPR, with
20 file rows and 6 action cards, were:

| Variant | Main thread ms/s | Paint ms/s | Raster ms/s | Software compositor ms/s | fps | Frames >33ms |
| --- | --- | --- | --- | --- | --- | --- |
| V1 shipped | 410 | 325 | 300 | 244 | 60 | 0/179 |
| V3 band per line | 171 | 29 | 0 | 4005 | 29 | 37/86 |
| V5 band per block | 15 | 1 | 0 | 1128 | 60 | 0/179 |

These are the profiling session's 3s windows, recorded on #1126. Software
rasterisation makes the compositor numbers relative evidence, not hardware GPU
or Android measurements. No additional measurements are claimed for V2/V4.
The maintainer explicitly chose to ship without a real-device measurement;
there is no Android performance claim and no stepped-animation fallback gate.

**The band.** A track spans the frame plus 0.6em on each side. Its band is
`max(100%, 9em)`, at opacity 0.56, with amber, purple and blue mask windows that
extend 8px above and below the frame and never repeat. The track and band
translate forward, their layout copies counter-translate, all over 2.6s with
`ease-in-out`. The sum keeps glyphs stationary while the band's left edge moves
from `−m − band` to `block + m`. A stationary frame clips the moving layers
at the owning frame’s inline edges, with 8px of vertical blur bleed. Its layout
box never extends sideways, so even a frame at the viewport edge adds no
horizontal scroll width. Slot blur remains unclipped within that frame.
The cycle boundary is colour-free; timing is
tested against this V5 path, not V1's separate per-line paths.

**Broad reflective sweep (maintainer revision).** The maintainer reviewed the
implementation and asked for a band about as wide as the text, with smoother
colour transitions, so the whole text lights up rather than one small focus
area travelling across it. The band therefore spans the full track, with a
9em minimum, instead of the prototype's 40%. At the middle of the cycle it
covers the whole frame. The amber leading ramp reaches opacity .08/.3/.65/1 at
9.23/18.46/29.23/40% of the band; blue mirrors it at
90.77/81.54/70.77/60%. The maintainer specifically requested longer transitions
on both sides; each outer fade therefore spans 40% rather than 26% of the band.
Purple and the inner ends remain percentages. These broad ramps scale with the frame; the earlier
fixed 2.34em edge ruling is superseded by this revision. The maintainer also requested a slight diagonal stagger within each block:
all three masks use a 110° gradient, leaving glyph geometry and the horizontal
motion path unchanged. Visual sign-off at
320px and desktop, in both themes, remains required before merge.

**Copies and media.** The internal band snapshots the committed loading layout
three times, preserving the exact seeded text, font, baseline and wrapping.
Supplied React children are mounted once. Copies are aria-hidden and inert;
controls and resources become empty boxes and only ghost glyphs paint. Custom
elements and customized built-ins also become boxes before cloning, because
inertness does not suppress their constructors; SVG resource tags use the same
guard irrespective of tag-name case. Their
blur is 1.2px greater than the base. Single-line text clips before the blur,
so ellipsis does not cut off blurred ends. Reduced motion hides the entire
band and disables every translation; print hides ghosts and the band. The
existing instant reduced-motion handoff and stream tail rules remain.


## 2026-10-07 — Sent tracks use AttachmentRow (#1143)

The [approved attachment composition](https://github.com/schlessera/brain-kit/issues/1143#issuecomment-6030745326)
and [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1143#issuecomment-6030989836)
use `AttachmentRow kind="doc"` for sent validated tracks. Identity and known
metadata come from existing intake/history: incoming name, format, byte count,
`sent`, a differing staged name and a no-line waypoint note. The static row
opens nothing. It has no role, tab stop, duration, waveform, extract or trust
line. Images retain their live zoomable thumbnails and count-only history chip;
the composer's retry/remove chips retain their queue behavior.

`kind` and `label` become required, and prototype attachment facts are removed
from runtime defaults. Metadata accepts several wrapping lines. The accepted
pre-1.0 API break ships in a minor: callers pass identity and optional facts
explicitly. This is an approved exception to D30's parity defaults; examples
remain in stories. No attachment protocol or persistence contract changes.


## 2026-10-07 — Code fences compose CodeBlock (#1142)

The maintainer approved retaining lazy syntax highlighting for chat code
bodies as an explicit exception to decision-only colour. The host passes
highlighted React children to the pure kit; it owns the clipboard action.
Keywords use purple ink, strings and additions teal, numbers and literals
gold, titles blue, comments muted italic, and deletions red. Other token
classes inherit the ordinary code ink. Every rendered token must meet 4.5:1
against the code surface in dark and paper, measured independently from
computed browser colours. The highlight theme requires the maintainer's
visual sign-off in Storybook before merge.

Copy occupies the head and uses the original React text descendants with
one trailing fence newline removed, including when file linkification
changes the painted text. Mermaid retains its earlier routing. Long lines
wrap without changing copied source. The kit draws no language, sample
command or copy glyph when the corresponding input/action is absent; the
maintainer accepted these pre-1.0 breaking changes in a minor. Other hosts
must pass `lang`, `code` or `children`, and their real `action` explicitly.
No tool schema, protocol or permission semantics change.


## 2026-10-07 — Recorded subagents use state rings (#1145)

The approved AgentOrbit design replaces the prototype progress radius with
three state groups: inner needs you, middle running, outer ended. A pending
approval is evidence only when its tool span descends from that agent in the
recorded run and belongs to its chat. Terminal outcomes win over older
approvals; success is done, failure outcomes are failed, and denied/cancelled
are neutral stopped. No timer, percentage or simulated completion is drawn.

Activity run detail mounts the overview only for at least two recorded child
subagents while Activity is supported and retained. Names are functional types
(or agent when absent), and completed metadata retains outcome and an actual
recorded duration. Pills open the existing chat subagent drill-in; the host
selects the recorded session when present. The complete span list retains
44px named drill-in targets, including on phones and beside the evidence rail.

Below a 480px container width the host requests compact 12px marks; these
are not controls. Labelled circles have fixed state radii and measured,
wrapping pills capped at 160px. Capacity is bounded by circumference and
actual rectangle collisions, including effective targets across rings. A
last-slot +N represents overflow and scrolls/focuses the full span list.
Very tall names that fit no slot are represented by that count rather than
clipped. Frame height can grow to contain targets; the 340px desktop orbit
needs 390px for three rings of 44px targets. No ring spins or transitions;
only running/waiting dots pulse, with the existing static reduced-motion
keyframes. The group names all three counts and creates no live region.

The accepted pre-1.0 break ships in a minor: OrbitAgent requires id/state,
AgentOrbit requires agents, progress orbit/angle are removed, RunState gains
stopped (including AgentRunCard), and core/sample defaults are removed.
This is an approved exception to D30 parity defaults; examples live in
fixtures and stories. Hosts pass compact and real navigation callbacks;
no new wire contract, telemetry or extension seam is introduced.


## 2026-10-08 — Offline continuity and committed recording boundaries (#1023)

The [September 30 rulings](https://github.com/schlessera/brain-kit/issues/578)
choose deferred explicit transcription, bounded persistent audio and minimal
cached cold capture. The [October 4 reconciliation](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5980965363),
[approved October 5](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5998617047),
replaces the conflicting proposal: auth loss stops capture and removes
protected views; IndexedDB partitioning makes no device-protection claim;
committed boundaries replace a one-second loss promise. The speech and account
rationale lives in [dictation-speech.md](dictation-speech.md#2026-10-08--local-capture-and-explicit-saved-audio-transcription-1023)
and [session-principals.md](session-principals.md#2026-10-08--device-local-account-partitions-and-auth-transitions-1023).

### Preserve work through transport loss

A warm transport outage keeps the established UI mounted
(`if (vpnStatus === "connected" || everConnected)`,
`packages/ui-react/src/components/connectivity/connection-gate.tsx:193-207`).
Connectivity feedback uses stable slots and an overlay; Send availability is
separate from editing. Replayed history reconciles with drawn chronological
parts, preserving answer/card/image identity rather than redrawing the reading
area. Transport recovery restores capability without submitting new local work.
The [real-host continuity proof](https://github.com/schlessera/brain-kit/pull/1232)
drives repeated drop/reconnect cycles at phone and desktop widths in dark and
paper Chromium cells, plus native IME and late-history cases. Its fixed initial
geometry baseline detects cumulative movement of the field and first visible
message; a cumulative geometry mutation fails it. This is pinned desktop
Chromium runtime evidence,
not Safari, Android or OS interruption coverage.

The device-local snapshot adopts the existing per-session draft identities
from [#951](https://github.com/schlessera/brain-kit/issues/951#issuecomment-6028717821),
so reload/auth recovery does not create a second draft store. Failed storage
shows the save failure and keeps editing in memory; it cannot claim that the
new edit is kept. Staged tracks remain in this tab only, including hidden-view
queues. Their [update hold](https://github.com/schlessera/brain-kit/issues/1112#issuecomment-6032010851)
and [manual-leave warning](https://github.com/schlessera/brain-kit/issues/1150#issuecomment-6033781561)
do not turn them into durable attachments.

D31's loud stale-client boundary remains. A per-root hold registry extends the
existing reload guard for drafts, staged tracks, live/draining dictation, review
text, capture/finalization, unaccepted transcripts, transcription and account
interaction. Busy local work defers update reload; holding a reload is not a
new error state (`registerBuiltInUpdateHolds`,
`packages/ui-react/src/lib/update-holds.ts:78-104`). The
[update proof](https://github.com/schlessera/brain-kit/pull/1194) observes actual
controller changes and reload counts. Live dictation hands words to review in
one update, including the [provider-ended path](https://github.com/schlessera/brain-kit/pull/1220),
so an empty textarea cannot release the hold while speech still awaits review.

### Recording, review and retention

Capture is explicit, visibly device-local, and never silently restarts on
launch, reconnect or permission grant. The sheet reports recording, remaining
capacity and Stop/confirmed Discard; timer ticks are not live announcements.
The tray distinguishes saved, interrupted, transcribing, failed and
transcript-ready audio. Playback and review remain local. Transcribe requires
its explicit upload confirmation and the server capability. Add to draft
persists the chosen draft and its receipt before accepted metadata/deletion;
failure keeps the recording. It never sends a message or answers an approval
(`async accept`, `packages/ui-react/src/lib/recordings.ts:651-679`).
The [tray runtime proof](https://github.com/schlessera/brain-kit/pull/1241)
measures focus, reading-anchor preservation, playback, failed writes and native
transaction ordering. Surviving transcript text remains reviewable even if its
audio is lost; ambiguous acceptance cleanup retains audio for playback/discard.

The [retention ruling](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5907064902)
sets **10 minutes per recording** and **100 MiB aggregate retained audio per
origin/device, across account and unassigned partitions**, with no age expiry
and no eviction to admit a new recording (`RECORDING_MAX_MS`,
`packages/ui-react/src/lib/recordings.ts:9-12`). The lower browser capacity
wins. Estimates are advisory; write success determines what exists
(`async function budget`, `packages/ui-react/src/lib/recordings.ts:191-201`).
Limits stop capture and keep a contiguous playable prefix, rather than cutting
an encoded chunk or deleting older work. Both quota and blob I/O errors stop
writes. The [store runtime proof](https://github.com/schlessera/brain-kit/pull/1230)
includes real elapsed ten-minute capture, failure forms, ordered/hash-checked
chunks and crash recovery.

**Saved up to** is the last chunk end whose chunk/index transaction completed,
not elapsed UI time or the requested MediaRecorder interval
(`const next =`, `packages/ui-react/src/lib/recordings.ts:291-307`). Requested
intervals and warning/minimum-budget defaults are tuning, never promises.
[#1250's measured fixture correction](https://github.com/schlessera/brain-kit/pull/1253)
further demonstrates why a visible recording sheet or a timeslice deadline is
not evidence of a durable chunk: the fixture now awaits the actual root-owned
commit before its unchanged saved-boundary/focus assertions. That test change
adds no recording capability or loss guarantee.

### Warm use, cached cold capture and uncached launch

Cold launch is a separate capability, not warm reconnect with remembered auth.
With durable capture enabled and a controlling worker that precached the shell,
the gate renders the eager local screen; it never opens protected chat/history.
A fresh page's new recordings are unassigned, with only aggregate locked audio
size visible. Server reachability alone neither adopts an account nor changes
the screen. **Continue** waits for startup recovery and drains initializing/live
capture before entering the normal gate/login
(`const leave`, `packages/ui-react/src/components/connectivity/local-capture-screen.tsx:94-99`).
Same-account authentication unlocks account work; unassigned audio still needs
explicit selected-only association before upload.

The [cold-launch runtime proof](https://github.com/schlessera/brain-kit/pull/1247)
uses an actual worker and cached/uncached fresh pages. The SDK owns NetworkOnly
API policy and navigation fallback; the generated worker entry, precache/web-app
manifests, index and offline pages belong to the public hosting template
([shell counterpart #11](https://github.com/schlessera/brain-hosting-template/issues/11)).
A first-ever uncached offline visit cannot boot this UI. Serving a capture view
requires prior successful online loading and retained cached assets; it is not
a blanket offline-ready claim. No authenticated API cache or full offline
history is approved. Host configuration prerequisites and user limits are in
[the hosting guide](../hosting/README.md#offline-use-and-local-recordings).

### Desktop browser measurements and their limits

All distributions below reproduce the
[V1 finding of October 7](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756),
whose repeatable probe is [PR #1204](https://github.com/schlessera/brain-kit/pull/1204)
under `scripts/probes/audio-commit-boundary/`, outside published packages.
Conditions: Playwright **1.63.0**, image
`mcr.microsoft.com/playwright:v1.63.0-noble`, Ubuntu **24.04.4 LTS**, host Linux
**7.2.5**, headed Xvfb without a window manager. Chromium **153.0.8010.12**
used a seeded **48 kHz** fake-microphone WAV; Firefox **155.0** used its native
fake stream. Both recorded **WebM/Opus**, requested **1000 ms** timeslices, and
committed each delivered chunk and index boundary in one IndexedDB transaction.
Loss is measured from recorder start to the observed interruption: **index
loss** subtracts the last committed delivery-time boundary; **playable loss**
subtracts the same-engine decoded duration of concatenated committed chunks.
These are probe observations under this stop policy, not product guarantees.

Main run: **seven runs per measured cell**; milliseconds **min / median / max**.
Every row is from the linked V1 finding above.

| Browser | Observed interruption | Index loss (ms) | Playable loss (ms) | Surviving storage, all seven runs |
| --- | --- | --- | --- | --- |
| Chromium desktop | Tab close, no unload | 24 / 436 / 789 | 22 / 437 / 785 | Index + some chunks |
| Chromium desktop | Renderer crash (`Page.crash`) | 7 / 463 / 820 | 9 / 466 / 820 | Index + some chunks |
| Chromium desktop | Whole browser SIGKILL | 109 / 453 / 739 | 111 / 452 / 741 | Index + some chunks |
| Chromium desktop | Hidden behind another tab for 6 s, then SIGKILL | 119 / 415 / 822 | 122 / 412 / 821 | Index + some chunks |
| Chromium desktop | Simulated capture-track end | −1 / −1 / −1 | −54 / −38 / −8 | Index + all chunks |
| Chromium desktop | Full disk, stop on first failed write | 1018 / 1021 / 1026 | 1017 / 1022 / 1025 | Index + some chunks |
| Firefox desktop | Tab close, no unload | 45 / 546 / 897 | 44 / 546 / 898 | Index + some chunks |
| Firefox desktop | Tab content processes SIGKILL | 274 / 404 / 643 | 276 / 406 / 645 | Index + some chunks |
| Firefox desktop | Whole browser SIGKILL | 53 / 361 / 743 | 53 / 362 / 746 | Index + some chunks |
| Firefox desktop | Simulated capture-track end | −12 / −8 / −3 | −27 / −12 / −1 | Index + all chunks |
| Firefox desktop | Full disk, stop on first failed write | 999 / 1000 / 1002 | 1002 / 1004 / 1006 | Index + some chunks |

A separate confirmation invocation of the final probe ran **five runs per cell**
under the same versions/timeslice/source conditions. Its **index-loss**
distributions (ms, min / median / max), also from V1, are:

| Browser | Case | Index loss (ms) |
| --- | --- | --- |
| Chromium desktop | Whole browser SIGKILL | 265 / 666 / 996 |
| Chromium desktop | Hidden then SIGKILL | 86 / 541 / 857 |
| Chromium desktop | Full disk | 1020 / 1022 / 1024 |
| Firefox desktop | Whole browser SIGKILL | 317 / 525 / 789 |
| Firefox desktop | Full disk | 999 / 1000 / 1000 |

No interrupted run lost its index or a previously committed chunk. **Index +
some chunks** means a recoverable prefix missing the unsaved tail, not deletion
of already committed chunks. Negative track-end loss reflects decoder padding
and recorder-start lag, not extra captured speech. The final track-end chunk
committed, but that simulated event says nothing about an incoming call. Kill
observations stayed below the requested interval; full-disk failures lost about
one chunk under the probe's stop-on-first-write-error policy. Neither result
establishes a universal tail-loss bound or background-capture promise.

Single capability reports per engine under those same V1 conditions found:

| Primitive | Chromium 153.0.8010.12 | Firefox 155.0 | Playwright Linux WebKit 26.6 |
| --- | --- | --- | --- |
| MediaRecorder | Present | Present | Absent |
| WebM/Opus support | Yes | Yes | No |
| MP4 support | Yes (capability only; interruption runs used WebM) | No | No |
| Default recorder container | WebM/Opus | Ogg/Opus (probe explicitly chose WebM) | None |
| IndexedDB Blob round-trip | Passed | Passed | Passed |
| Storage persistence request | Returned false | Did not settle within 3 s; prompt unanswered | Returned false |

A separate single Chromium visibility capability trial delivered and committed
**ten chunks in ten seconds hidden**, still at the requested **1000 ms**
interval. The single CDP freeze trial produced **four chunks during a five-second
freeze request**, with no freeze event: it failed to induce a freeze and is
**not** a freeze measurement. The full-disk runs used a **48 MiB** disk;
Chromium still estimated **1 GiB** quota/zero usage, while Firefox reported
**10 MiB** quota. Chromium failed with blob `DataError`/IOError; Firefox with
`QuotaExceededError`. These V1 results explain why estimates/persistence requests
cannot establish durable capture or free physical space.

### Unmeasured cells and detectable storage loss

The [October 7 desktop-suffices ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6040793673)
permits dependent work on the desktop results. The
[later scope ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836)
keeps Safari unmeasured and transfers attainable Android/OS/lock cells to
[#1236](https://github.com/schlessera/brain-kit/issues/1236). None of the
following is inferred from desktop tests or documentation. Every row links the measurement handoff for context. #1236 owns the attainable
Android, real OS interruption and screen-lock measurements; it does not expand
to the desktop/storage omissions below, and Safari remains excluded by the
ruling.

| Cell | Finding and reason | Tracking |
| --- | --- | --- |
| Android Chromium, every capture/interruption cell | **NOT MEASURED**: no device in V1; emulator measurements not supplied | [#1236](https://github.com/schlessera/brain-kit/issues/1236) |
| Safari macOS, every cell | **NOT MEASURED**: no available Apple device; Linux WebKit is not Safari | [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236), [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836) |
| Safari iOS tab, every cell | **NOT MEASURED**: no available Apple device | [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236), [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836) |
| Safari iOS installed PWA, every cell | **NOT MEASURED**: no available Apple device; no inference from tab/emulator behavior | [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236), [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836) |
| Linux WebKit 26.6, every recording-interruption cell | **NOT MEASURED**: its MediaRecorder is absent | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 handoff](https://github.com/schlessera/brain-kit/issues/1236) |
| Firefox hidden-then-kill / hidden delivery | **NOT MEASURED**: separate windows and no window manager prevented hiding a tab | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 handoff](https://github.com/schlessera/brain-kit/issues/1236) |
| Real OS microphone interruption, any browser | **NOT MEASURED**: only track end was simulated; no call/OS event was produced | [#1236](https://github.com/schlessera/brain-kit/issues/1236) |
| Screen lock / actual background freeze, any browser | **NOT MEASURED**: container cannot lock a real screen; Chromium ignored CDP freeze | [#1236](https://github.com/schlessera/brain-kit/issues/1236) |
| Browser eviction and private-mode lifetime, per browser | **NOT MEASURED**: V1 neither provoked eviction nor ran private profiles | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 measurement scope](https://github.com/schlessera/brain-kit/issues/1236) |
| User-cleared site data, per browser | **NOT MEASURED**: V1 did not clear the origin during its trials | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 measurement scope](https://github.com/schlessera/brain-kit/issues/1236) |
| Origin quota lower than free disk, per browser | **NOT MEASURED**: runner could fill a disk but not impose an engine quota reflected by estimate | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 measurement scope](https://github.com/schlessera/brain-kit/issues/1236) |

Eviction, private-mode lifetime and cleared site data are limitations, not
measured loss distributions. Injected product tests establish what recovery
can do with surviving data; they do not measure when a real browser evicts it:

| Surviving evidence | Recovery boundary |
| --- | --- |
| Index + all chunks | Saved audio; an unfinished capture is marked interrupted |
| Index + some chunks | Interrupted contiguous playable prefix; saved boundary is adjusted |
| Index but no audio chunks or transcript | Persistent removed-recording notice |
| Index and unaccepted transcript, but no audio chunks | Transcript-ready review with an audio-unavailable explanation; transcript is kept, with no added removed-recording count |
| Neither index nor chunks (and no other surviving record) | Nothing can be listed or reported; no loss notice can be promised |

Recovery uses the surviving index and ordered chunks
(`async recover(partition)`, `packages/ui-react/src/lib/recordings.ts:516-580`).
The store tests force missing-chunk states, including a full origin that cannot
repair metadata. Requesting `navigator.storage.persist()` is best effort; no
copy calls it a guarantee. No unload callback can save data after a crash, and
no local UI can report a recording after all evidence of it has disappeared.

## 2026-10-07 — StreamingAnswer is the turn's waiting status (#1144)

The [approved waiting composition](https://github.com/schlessera/brain-kit/issues/1144#issuecomment-6030764508)
and [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1144#issuecomment-6031007929)
retain the existing rich thinking/tool/prose renderer and the composer's one
Stop control. Before any group arrives, the waiting row shows `thinking` and
two ghost lines; arrival unmounts it immediately. A pending approval in the
last tool group shows one static `waiting for approval` row under the controls.
Retry shows the existing protocol helper's wording. A restored pending
approval keeps its waiting row until the host closes it, even though replay
has no text stream. Terminal turns draw no waiting row. Status belongs to the message in its root/session/turn.

Elapsed time uses a matching host turn start when supplied; otherwise a turn
started on this page uses its timestamp. A recovered shell without host timing
shows none. Only the phase word is a polite live region, so elapsed ticks and
target changes do not announce. No answer text, cost or progress is passed.

The approved pre-1.0 minor removes the kit's prototype phase, target, elapsed,
answer and cost defaults. Callers supply facts explicitly; `pulse` selects a
working pulse or static decision-wait dot. Existing ghost-band and streamed
text animations retain their implementations. This is an approved exception
to D30's parity defaults, and no stream/cancellation contract changes.


## 2026-10-09 — D54: one overlay primitive (#1378)

The design ruling on #1378 adopts native `showModal()` dialogs for modal
overlays and a non-modal destination panel that keeps navigation operable.
`Overlay` owns opening order, dismissal requests, focus entry/wrap/return,
inertness and entry-only motion. Closing is instant. Entry animations share
one `no-preference` guard; reduced-motion overrides share the existing
`reduce` block. Scrims use existing
`palette-shadow` (dim), half that shadow mixed with transparent (veil), and
`color-canvas` (opaque); none uses blur.

| Variant | Shape | Modal | Scrim | Used for |
|---|---|---|---|---|
| `sheet` | Docked to the bottom at every width. Full width below 480. From 480, `min(560px, 100vw − 32px)` wide and centred horizontally. | yes (top layer) | `dim` | Short pick-lists and live tools that belong at the thumb: More, Attach (phone), Graph options, Dictation (phone and tablet). |
| `dialog` | **Below 900 it has the sheet's shape.** From 900 it is a centred card, `radius-panel` (18px), at most `85dvh` tall, with the body scrolling. `placement="top"` puts the card 110px from the top and never docks it to the bottom (palette). | yes (top layer) | `dim` | A single decision or a single reading: handoff, the one-time credential (`alertdialog`), the command palette (`placement="top"`). |
| `fullscreen` | Covers the viewport at every width, `--bk-color-canvas` opaque. The children draw the toolbar. | yes (top layer) | `opaque` | Tools that need the whole screen: the zoom viewer, the mask editor, the subagent drill-in. |
| `panel` | Right-anchored. Full width below 768. From 768 (`md`), `size` sets the width: 320, 480 or 560. Full height, with a left `edge` hairline and the shadow. | `modal` prop. `true` (default) for act panels, which use the top layer and cover the bar and rail. `false` for destination panels: z-index `panel`, inert only over the content area, bar and rail stay live. | `veil` | The slide-over panels: Sessions, Settings and Files (destination, `modal={false}`); Search, Add, Sync and Whatsup (act, modal). |


The document layer scale is fenced separately from the colour-token pipeline;
`LAYERS` exports its numbers and `z` exports its CSS references. Kit and app
Tailwind themes map these names to `z-raised` through `z-modal`.

```css
/* @layers:start */
:root {
  --bk-z-raised: 10;   /* sticky headers/footers, floating in-canvas controls */
  --bk-z-popover: 20;  /* anchored non-modal popovers and menus */
  --bk-z-nav: 30;      /* phone tab bar; the rail if it is ever positioned */
  --bk-z-panel: 40;    /* non-modal destination panels + their content scrim; ≥900 panes */
  --bk-z-banner: 50;   /* the connection banner */
  --bk-z-modal: 60;    /* fixed modal layers not yet in the top layer (kit SheetDialog, ModelPicker phone) */
}
/* @layers:end */
```

| Case | Winner | Mechanism |
|---|---|---|
| More (sheet) opened over the Files or Sessions drawer (destination panel) | More | Top layer > `z-panel`. The nav no longer needs to raise itself. |
| One-time credential appears while the Settings drawer or pane is open | Credential | Top layer > `z-panel`. Settings stays open underneath, and Done returns focus into it. |
| Credential appears while another modal is open (e.g. a sheet) | Credential | Opened last, so it is on top of the top layer. The sheet is inert underneath. |
| ⌘K while a modal is open | Nothing opens | The palette's ⌘K handler toggles only when no other modal is open (`openModal()` in `lib/destination-start.ts`, which already matches `[aria-modal="true"], dialog:modal`). Otherwise a palette could stack over a `closedBy="none"` credential. |
| Handoff from the ModelPicker's locked action (phone) | Handoff | The picker closes first in the composer. If it ever stays open, the top layer still wins over its `z-modal`. |
| Zoom viewer opened from inside the subagent drill-in | Zoom viewer | Opened last in the top layer. Escape closes only the viewer. |
| Palette over the Settings or Files pane (≥900) | Palette | Top layer > `z-panel`. |
| Connection banner vs a destination panel | Banner | `z-banner` 50 > `z-panel` 40. |
| Connection banner vs any modal | Modal | The top layer is above the banner, and the banner is inert and dimmed under the scrim. Its live region is not announced while a modal is open. That is accepted: a modal is the current task, and the banner shows again when the modal closes. |
| Phone tab bar vs destination panel | No overlap | The panel stops above the bar (`bottom: calc(60px + env(safe-area-inset-bottom))`). |
| Phone tab bar vs act panel (Search, Sync…) | Act panel | Modal panel in the top layer covers the bar, as today ("an act's panel keeps covering them"). |
| Anchored popover vs a panel | Panel | `z-panel` 40 > `z-popover` 20. A popover inside a panel lives in the panel's own stacking context. |
| Toasts | n/a | There are no fixed toasts. `InlineToast` is in flow. |


The breakpoint is 900px for dialog-to-sheet geometry; `placement="top"`
stays at 110px at every width. Sheets stay docked at every width, with a
48px minimum scrim strip and a default 70dvh cap. Panels size at 768px;
destination panels stop above the 60px phone bar or beside the 60/208px rail.

The native modal uses no z-index. ZoomViewer keeps a body portal to avoid
markdown inline nesting and prose image styles. Escape bubbles through inner
controls, then only the topmost overlay requests dismissal. `cancel` is
prevented when cancelable; an unexpected native close reopens and restores
initial focus before requesting dismissal (unless `closedBy="none"`).
A panel keeps its header X under every `closedBy` value; `none` suppresses
Escape, native close requests and scrim taps only. Sheets and dialogs remove
their drawn close control under `none`. The adapter may capture the surface
with `surfaceRef` for destination resets.
Focus returns according to the closing render, in a microtask after the React
commit has restored focus and after
inertness is released and before `onAfterClose`. Destination inert marks
are ref-counted, follow inserted siblings, exempt active modals and their
ancestors, and preserve page-owned inert. Hidden modal subtrees close immediately and report
a developer error in development builds.

`BottomSheet` optionally draws a 44px close control; existing stories omit it.
`CommandPalette` is a named group, using its own root ref for row traversal,
inside the owning dialog. Its pixels do not change. Only the 24 new overlay
baselines are approved; no existing baseline changes.


## 2026-10-09 — D55: native icon and text actions (#1379)

The [design ruling](https://github.com/schlessera/brain-kit/issues/1379#issuecomment-6087751547)
adopts `IconButton` for icon-only controls and `TextButton` for inline text
actions. Both render native `button type="button"`, forward refs for React 18,
and pass `data-*` hooks. `Button` retains its existing API and element;
`DiscButton` remains limited to D52's three transcript discs.

`IconButton` has mute, danger and overlay tones. Its md box is 44px; sm is
28px with a 14px glyph and grows its paint and target to 44px under
`any-pointer: coarse`. Mute hovers to the strong veil and ink; danger stays
red at rest and hover. Overlay uses raised at 80% with ink-dim: ink-mute
fails over arbitrary media, while ink-dim clears 4.5:1 over both white and
black in both themes. Expanded mute triggers stay raised and ink.

`TextButton` formalises the existing ask-list text actions: body link text
uses teal-ink and an underline, mono meta uses ink-mute and lifts to ink-dim
with an underline on hover, and inherit takes its context's font and colour.
Underlines are text-decoration (D34). Standalone targets are at least 44px
tall; inline paint has a 20px minimum box and reaches 12px vertically and 4px
horizontally, requiring 8px between neighbours. The minimum preserves 44px
reach even when inherited text has a shorter line height, without changing
its font. Both primitives retain a 2px focus ring at offset +2,
a pressed translation, and native disabled behaviour at opacity .45.

Composite hit areas remain raw with a closed reason vocabulary:

| Code | Reason |
| --- | --- |
| `row` | Composite full-width list, menu or disclosure content that ListRow cannot draw. |
| `select` | Selection with its own ARIA role or state; no fitting kit segment/tab control. |
| `surface` | A kit card or rendered page is the hit area. |
| `canvas` | Canvas/media tool with that surface's own palette. |
| `kit` | Already uses kit tokens and bk-control, with a reason the component cannot fit. |
| `api` | Requires a native capability absent from the kit control; name that capability. |
| `dev` | Dev-only harness. |

The marker grammar is `raw-button: <code> — <reason>` (a hyphen also separates
code and reason); the reason has at least 12 characters. Put the comment
inside the opening tag, as `//` between attributes or `/* */` on one line.
A marker travels with the element and stays out of the DOM; a file:line
allowlist drifts and a per-file count cannot explain a second button.
Row and select sites use bk-row interaction, preserving selected/rest paint.
The raw-button lint and consumer migrations are separate batches; this
ruling approves only new primitive baselines for the kit batch.
