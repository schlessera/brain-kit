# Brain Kit UI — locked decisions

Source of record for the Storybook/design-kit effort. Append-only: supersede
entries, do not rewrite history.

## 2026-09-15 — kickoff decisions (confirmed by the maintainer)

| # | Decision | Chosen | Rejected alternatives |
|---|----------|--------|-----------------------|
| D1 | Package layout | Single new `packages/ui-kit` with `.storybook/` inside it. Published package; storybook devDeps excluded from `files[]`. `packages/ui-react` rewires to consume it in step 2. | Separate `ui-storybook` app package; Storybook inside existing `ui-react` |
| D2 | Test depth | Interaction tests (play functions) + accessibility tests (addon-a11y/axe, failing CI) + self-hosted visual regression (Playwright screenshots, baselines committed) | Chromatic (paid/hosted) |
| D3 | In-chat component API | Tool call renders a component: LLM calls a brain MCP tool, the tool result carries a typed payload the chat surface renders. Schemas are the contract. | Fenced markdown blocks; both; renderer-only polish |
| D4 | Scope of step 1 | Everything present in `kit/Brain Kit.dc.html`, and no more — plus the state variations needed for real coverage (loading / empty / error / mobile). Do not invent components the design does not show. | Full ui-react surface coverage; core-chat-only vertical slice |

## Binding repo rules that constrain this work

From `AGENTS.md` — these are not negotiable and every wave must respect them:

- **No personal data anywhere in the tree.** Fixtures use the fictional persona
  "Alex Example". CI runs a leakage gate over the whole tree with no exempt
  directories — Storybook fixtures are in scope.
- **Contract stability.** CLI `--json` shapes, MCP tool names and schemas,
  `schema_version` and frontmatter semantics are the compatibility contract
  (`docs/integration-contract.md`). New in-chat MCP tools mean a `CONTRACT:`
  commit and a doc update in the same commit.
- **No new seams.** Extension interfaces only where a second implementation is
  plausible within a year.
- **Skills orchestrate, the CLI executes.**
- **No raw control or invisible characters in source** — `bun run lint` gates it.
- **A new package must be added to `scripts/publish.ts` and `scripts/build.ts`**
  — both drive hardcoded lists. Asserted by `tests/release-manifest.test.ts`.
  `ui-kit` must be added to both, or it is silently skipped at release and its
  dependents ship pinned to a version nobody published.
- All `@schlessera/brain-*` packages version in lockstep.
- Tests: `bun run test` (supplies `--timeout 30000`). Never add a test that
  needs an API key or the network.

## Open questions

- [ ] Awaiting `kit/Brain Kit.dc.html` (blocked on `/design-login`) before the
      component inventory can be finalised.

## Constraints discovered during research

- **`.plan/` is inside the leakage gate, and this bit us.** `scripts/check-leakage.ts`
  scans the whole tree *including untracked files*, and `.plan/` is not
  gitignored. Two ways to trip it, both observed:
  1. An absolute home-directory path — the home path contains a banned personal
     string. Use repo-relative paths everywhere.
  2. **Attributing a decision to a person by name.** Six lines in these very
     files named the maintainer directly and failed the gate on a tree that was
     otherwise clean. Fixed by attributing to the role instead. (Writing the
     note about this mistake, with the name quoted as the example, failed the
     gate a second time — the gate does not care about context.)
  **Standing rule: in anything under `.plan/`, refer to people by role, never by
  name.** Run `bun scripts/check-leakage.ts` before committing plan docs — it is
  the same gate CI runs, and it has no exempt directories.
- **There is no bundler in this repo today.** `ui-react` builds with plain `tsc`
  plus one `@tailwindcss/cli` pass; `ui-server` serves a pre-built SPA it does
  not build. The client shell (index.html, mount point, Vite/PWA build, service
  worker) lives in the separate `brain-ui` repo. Storybook/Vite would be the
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

Grounded in `.plan/research/storybook-2026.md`, whose findings were *executed*,
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

Full proposal: `.plan/architecture/state.md`. Summarised here; **not yet ratified**
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
`.getInitialState()` in three places (`render-smoke.test.tsx:117,118`,
`graph-store.test.ts:105`). `Object.assign(hook, store)` covers it; a
hand-picked two-method shim would not.

**D3's premise was overstated.** Only **two of four** Pi bridge tools return
`textResult(JSON.stringify(payload), …)` — `ask_user` and
`get_current_location`. `query_activity` returns prose with nonce-delimited JSON
inside, and `request_image_mask` returns a human-readable sentence with the
structure in `details`. Worse: **the Pi adapter sends text content only and drops
`details`** (`event-adapter.ts:34,46`), and Claude uses MCP `content` arrays via
a different path (`stream-adapter.ts:132`). So "JSON payload in the output
string" is a *convention we would be establishing*, not one we are following.
The no-bump conclusion still holds — `protocol.ts:41` states additions do not
bump the rev, only semantics changes do — and `ToolCallView.output?: string`
already lets a renderer parse locally. Turning `output` itself into an object
would be a different, breaking change.

**Claim 5 is genuinely broken as written.** Zustand's `UseBoundStore` carries two
overloads, `(): State` and `<U>(selector) => U`. The proposal's wrapper declares
only the selector form, which the TypeScript compiler rejects against the real
`UIState`: `TS2554 Expected 1 arguments, but got 0` and `TS2322 not assignable to
UseBoundStore<StoreApi<UIState>>`. That hits **all nine exported store hooks**.
No current source component calls the zero-arg form, so runtime is fine — this is
a pure *type* break, and a type break is a breaking change for TS consumers. Fix
is cheap (declare both overloads), but the "therefore it is a minor" reasoning
does not stand on its own and must be re-argued after the wrapper is written.

**SSR concern dismissed, with evidence.** All three construction-time
`localStorage` reads are guarded (`chat-store.ts:364`/`228`,
`provider-store.ts:44`/`8`, `file-store.ts:135`/`26`); no initialiser touches
`matchMedia` or `window` unguarded, and fetches happen inside actions. A
fresh-process import of `src/index.ts` with `window`/`localStorage` absent and
`fetch` replaced by a throwing sentinel succeeded. An eager default root is safe.

**The renderer bug is real and was reproduced**: register → resolve (non-null) →
reset → register → resolve (**null**). `registered` in
`components/chat/renderers/index.ts:10` is never cleared by
`resetToolRenderers()` (`ui-sdk/src/client/renderers.ts:127`). The existing
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
`.plan/fixtures/universe-options.md`; world choice still open.

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
Research and measurements in `.plan/research/map-tiles.md`.

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
`.plan/design-feedback.md` as a source defect.

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

Ten entries, `.plan/design-feedback.md` §§4-13. The four contrast ones (§§4-7)
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
