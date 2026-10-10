# Design kit — Storybook and accessibility

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-15--storybook-stack-decisions"></a>

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

<a id="2026-09-15--viewport-and-the-accessibility-gap-maintainer"></a>

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

<a id="2026-09-15--d17-is-closed-the-accessibility-gate-is-real"></a>

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

<a id="what-the-gate-now-enforces"></a>

### What the gate now enforces

Every axe rule, on every story, in real Chromium, failing the run. The single
sanctioned exception is `knownContrastGap(reason)` in `stories/_stage.tsx`, which
disables **one rule on one story** and requires the call site to state why. Nine
call sites use it — two of them at a `meta`, because the same defect is in every
story of that file — for four causes, all of them palette decisions. Every other
axe rule still runs on those stories, and `color-contrast` still runs on the
rest.

<a id="what-remains-a-documented-gap"></a>

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

<a id="two-divergences-from-the-source-both-recorded"></a>

### Two divergences from the source, both recorded

- **`FileRow`: every operable row is a `treeitem`.** The source picks per row —
  `treeitem` for a folder, `option` for a file — and **no container satisfies
  both**, so axe failed it from both ends at once and no call site could have
  fixed it. The design's own role table says `button` / `treeitem` and never
  mentions `option`, so this moves the port towards the spec. §9.
- **`Toggle` gained `label` / `labelledBy`.** Net-new: the design draws a switch
  as pure geometry, and a switch is the one control with no visual words to fall
  back on. §12.

<a id="three-findings-that-generalise-past-this-wave"></a>

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

<a id="bk-controlhover-and-bk-rowhover-are-no-longer-symmetrical"></a>

### `.bk-control:hover` and `.bk-row:hover` are no longer symmetrical

Wave 4 gave `.bk-row:hover`'s background a `, transparent` fallback so a
component setting only `--hv-fg` would not have its background reset. `.bk-control
:hover` has no such fallback on `border-color`, so an unset `--hv-bd` there is
invalid at computed-value time and resets the border to `currentColor`.

**Consequence, now load-bearing:** a toned `.bk-control` cannot simply decline to
move its border on hover — it has to restate it. `Placeholder`'s retry sets
`--hv-bd` to its own rest border for exactly this reason, and the reason is
written next to it, because the code looks like a redundant no-op and is not.

