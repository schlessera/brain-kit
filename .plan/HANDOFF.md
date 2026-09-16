# Handoff — brain-kit UI design system

Read this first, then `.plan/DECISIONS.md` (the reasoning, D1-D31) and
`.plan/PLAN.md` (the wave checklist). Everything needed to continue is on disk;
nothing important lives only in a session transcript.

## What this is

A new `packages/ui-kit`: 58 presentational React components ported from a Claude
Design system, with Storybook inside the package as the surface for iterating on
design, copy and layout. Step 2 — not started — rewires `packages/ui-react` onto
it and reshapes the state architecture.

## State

| Wave | Scope | Status |
|---|---|---|
| 0 | Package, Storybook 10.6, CSF Next, tokens, lint gate | done |
| 1 | 12 primitives + Placeholder | done |
| 1b | Accessibility; a11y gate at `error`, **proven red then green** | done |
| 2 | Rows, evidence, decision surfaces (14) | done |
| 3 | In-chat blocks + conversation lifecycle (20) | done |
| 4 | Agent views, chrome, desktop nav (12 + ScreenBody) | done |
| 4b | Roving tabindex on the four composite widgets | done |
| 5 | The four assembled screens — the acceptance test | done |
| 6 | D3 in-chat tool contracts | not started |
| 6b | MapView coastline geometry (D25) | done |
| 7 | Visual regression (D10) | done |
| — | Server-side map geometry for arbitrary places | done, one fixture outstanding |
| Step 2 | Rewire `ui-react`, reshape stores (D13/D15) | not started |

Fixtures: the Odyssey world under `packages/ui-kit/fixtures/`, 16 people, 20
places with verified real coordinates, pinned to 2026-07-12, 38 invariant tests,
plus OSM geometry for five locations under `fixtures/geo/` (**ODbL, not MIT** —
see the LICENSE in that directory).

## How to run it

```sh
bun run test            # whole suite
bun run lint            # six gates, including the leakage gate
bunx tsc --noEmit       # typecheck
cd packages/ui-kit && bunx storybook dev      # the design surface
cd packages/ui-kit && bunx vitest run --project=storybook   # browser tests, fast
bun run test:browser    # BOTH browser projects, in the pinned image — what CI runs
bun run visual          # visual regression only
bun run visual:update   # rewrite the baselines, after a deliberate visual change
bun packages/ui-kit/tools/dc-parity/compare.ts              # DC parity harness
bun packages/ui-kit/tools/geo/generate.ts [id...]           # refetch map geometry
```

**Never commit a baseline from a host run.** `bun run visual:update` goes
through the container; a bare `vitest --project=visual --update` does not, and a
host-generated baseline does not merely differ — it makes the matcher retry
until the test times out, so the next failure does not even look visual.

If `tsc` or a test dies with `SIGTRAP` or exit 133 and a V8 stack, **re-run it**
— that is a known non-deterministic node JIT crash, documented in the release
skill. It is not your change.

## Traps that have already cost time

1. **`DesignSync` is main-session only.** Subagents do not get the tool. Fetch
   design files from the main session; `.plan/FETCH-PROGRESS.md` documents the
   extractor that harvests them from the transcript without hand-relaying.
2. **The leakage gate scans untracked files with no exempt directories.** Never
   write an absolute home path or a person's name into `.plan/`. Refer to people
   by role. Run `bun scripts/check-leakage.ts` before committing docs.
3. **A local `storybook build` used to turn the gate red** — the components
   manifest records absolute paths. `storybook-static` is excluded now, but do
   not deploy that directory without checking what the manifest contains.
4. **`@theme` must stay `@theme static`** or Tailwind prunes every token out of
   the published stylesheet. Asserted by a test. Grep the built CSS to verify
   anything about CSS; a green build is not evidence.
5. **The minifier collapses `::before` to `:before`.** Grep both.
6. **A story that measures geometry owes its own width** (D28) — `layout:
   "centered"` shrink-wraps the root, so `max-width` never binds.
7. **`width: 100%` on a component root is live** since wave 1 dropped the DC
   wrapper, and ~15 components declare it. Two side by side in a flex row
   overflow. This is the **wave 5 hazard** and it has already bitten once.
8. **The kit's stylesheet is mandatory** (D23). No `var(--x, #hex)` fallbacks —
   a stylesheet-less consumer renders colourless on purpose, because the
   alternative hands a light-theme consumer dark defaults.

## The map, which grew a server half this session

`MapView` is still prop-driven (D13) and fetches nothing. What it gained is
enough machinery around it that the whole thing works for anywhere, not just
the five fixture locations:

- **`@schlessera/brain-ui-sdk/server`** — `fetchCoastline` plus the pure
  geometry under it (`clipLine`, `simplify`, `closedRings`, `prepareLand`,
  `detailFor`). No mapshaper: 15 MB and 31 dependencies for two short
  algorithms was the wrong trade, and the hand-written versions were validated
  against it on real geometry first — same Overpass response, **identical
  extents to four decimal places**.
- **`GET /api/geo/coastline?bbox=w,s,e,n`** in `ui-server`, fetched once and
  cached on disk forever. The cache is not an optimisation: Overpass's usage
  policy is written for light interactive use, and one request per place ever
  is what makes using it defensible. No TTL, because coastlines do not move.
- **Detail tiers.** Shape only above 40 m/px, the road network between 8 and 40,
  every street below 8. The caller does not ask, so it cannot get it wrong.

Five things here will bite someone who does not know them:

1. **The projection must never stretch.** `px()`/`py()` used to map each axis
   across the whole box independently; the bbox is now expanded on its short
   axis until one pixel is the same distance both ways. `ONE SCALE FOR BOTH
   AXES` in `tests/mapview-projection.test.tsx` is the gate, and it exists
   because **every other test in that file renders at exactly `width`**, where
   pixels and percentages coincide and nothing compares the two axes.
2. **`spanKm` is the span across the WIDTH.** Applied to both axes it made a
   card captioned "18 km" draw forty.
3. **Overlays are percentages, never projected pixels.** The SVG scales to the
   card; absolutely-positioned HTML does not. And the pin's DOT sits on the
   coordinate — `translate(-50%,-50%)` centres the whole label row, which put
   the dot half a label away from the place it marks.
4. **Land is islands only.** Closed rings need no decision about which side is
   water; a mainland shore has to be closed against the viewport, which D25
   measured getting three of five wrong. The winding convention that makes that
   tractable was verified — **486 of 486 rings counter-clockwise** — so it is a
   contained second step now, not a research problem.
5. **`fetchCoastline` degrades to empty on any failure and that is deliberate**
   — a plainer map beats a message that will not render. It is also why the
   fixture generator must not inherit it: it wrote an empty fixture over a good
   one the first time Overpass answered 504. The generator retries with backoff
   and throws without writing; the route serves a `partial` result but never
   caches one.

**Overpass rate-limits hard.** It answered 504 for the last stretch of this
session on the canonical instance and on the kumi mirror. `OVERPASS_URL` points
the generator elsewhere; mirrors can be months behind, so the canonical instance
is the default.

## The one piece of outstanding work

`bun packages/ui-kit/tools/geo/generate.ts vathy` — the location is declared and
the fixture is not committed, because Overpass would not answer. **Vathy is the
demo for the detail tiers**: the same verified Ithaca coordinate at 1.8 km
instead of 12, so the same island appears twice, two orders of magnitude apart.
The world already has the pins for it — Penelope in the hall, Eumaeus' farm,
Laertes' upland farm, Argos — and OSM has 107 street ways there (confirmed by a
direct query). It needs a `vathyMap` scene and a story once the data lands.

While there: `troy` and `messina` predate `land` and carry no `land` key. The
loader treats that as "no fill", which is also the right answer for a mainland
bbox, so nothing is broken — but they are due a regeneration pass.

## Open questions for the maintainer

- `.plan/design-feedback.md` holds defects that need the **designer**, not code:
  every hit-target expansion on a bordered element is short by its border;
  `ContactCard` cannot express severity in a fact; `neutral` means four
  different things across four components; `AgentRunCard` has a fallback that
  can never fire. §10's three unlanded key bindings need a WCAG 2.1.4 answer,
  and §11 closed with one new question: whether `Home` / `End` should join the
  role-and-keys table now that the groups are composite widgets.
- The light theme is specified with a full token contract but **not wired** —
  the tokens exist with dark values and a `[data-theme="light"]` stub.
- Whether the even 50/50 split on `ApprovalCard`'s buttons stands, or reverts to
  the content-sized render DC actually draws (155/65). One property, two nodes.

## The accessibility gate, and what it does not see

`parameters.a11y.test` is `'error'` and was proven before it was trusted: the
same seeded violation gives **503 pass / 0 fail at `'todo'`** and **497 / 6 at
`'error'`**. The first row is the finding, not the control — `'todo'` really is
silent.

Note the method, because it generalises: a first seed attempt was **discarded**
because it also failed at `'todo'` — caught by this wave's own
`findByRole({ name })` assertions rather than by axe. **A seed only proves a
gate if nothing else in the suite can see it.**

**The gate's blind spot matters more than its coverage.** axe only sees what a
story renders. `design-feedback.md` §7 records a contrast failure axe never
found — a solid button's effect chip is under 4.5:1 on every tone, and no story
renders that combination. `packages/ui-kit/tests/contrast.test.ts` exists for
exactly this: it recomputes every figure from the tokens rather than waiting for
a rendered pixel.

## Roving tabindex, done — what it left behind

`src/internal/roving.ts` holds `useRoving` and `focusSibling`. `TabBar`,
`SideRail` and `FilterRow` each own their group and hold the state; `ChoiceOption`
cannot — it is one option inside its caller's `radiogroup` — so it takes a
`tabStop` prop and `AskUserCard` drives it. The navigation now costs **two tab
presses, not ten**, and `stories/rules/Keyboard.stories.tsx` still asserts a list
of names rather than a count.

**The clause to not lose in a refactor:** the stop falls back to the FIRST
ELIGIBLE item. Without it a group with nothing selected — an unanswered
`AskUserCard`, which is its common state — is not harder to reach but completely
unreachable. Four stories exist only to hold that clause down, and all four were
proven by seeding the naive implementation. `design-feedback.md` §11 is now the
record of the fix rather than of the defect.

A real bug fell out: `FilterRow` fired `items[n]` with `n` from the DOM walk,
which only visits interactive pills, so a mixed row filtered by the wrong one.

## Wave 5, done — and what it changed about the traps above

**The component set held.** All four screens are assembly; none needed a new
component. `tests/screens-are-assembly.test.ts` now enforces that over the
source — every capitalised JSX tag imported from `src/`, every inline style
layout-only, no colour literal — so screens 2-4 inherited the rule by existing.

What assembly surfaced was **six defects in components that each passed their
own stories**, because a component's own stories put it in a container built for
it and a screen does not. Four were kit bugs and are fixed; two need the
designer. `.plan/design-feedback.md` §14.

Two of those are worth carrying forward as rules:

- **`ScreenBody` children must not shrink** (`.bk-screen-body > *`). Without it
  an over-full screen squeezes every child instead of scrolling, and it fails as
  somebody else's bug — a `FilterRow` clipping its own labels, an `ActionCard`
  eating its last line, a `margin-top: auto` that silently stops spacing.
- **A screen may not render more than it can reach.** `unreachable()` in
  `stories/_stage.tsx`. `overflow: hidden` is right for a specimen and is a trap
  on a screen: the clip looks like the end of the content.

## The trap wave 7 was built for

**Two components were visibly broken in Storybook and passed every test.**
`GraphView` rendered a 2px vertical line for a whole wave — everything inside it
is absolutely positioned, so its intrinsic width is zero and `width: 100%`
against Storybook's shrink-to-fit centred root resolved to nothing. All six of
its stories passed, and none of them *could* have failed: percentages of zero
are all zero. `LaneChart` drew one run as two, against the only argument the
component makes. Both were found by a person looking at the design surface.

`.plan/design-feedback.md` §15. The practical rule: **assertions about props,
roles, counts and computed styles cannot see a component that has vanished.**

Wave 7 now covers it — both defects were re-seeded against the finished suite
and caught in under 250ms each. Two things about it are worth knowing before
touching it:

- **A baseline only catches what its story renders**, which is the same blind
  spot the a11y gate has. Reintroducing the `GraphView` collapse did NOT fail
  `paints: graph view`, because `Default` renders in a stated-width wrapper now.
  The subject that catches it is the story that reproduces the condition, and it
  is in the set separately.
- **The subjects are curated on purpose** — the four screens, the components
  that paint, two dense cards. Snapshotting all 536 stories would produce PNGs
  nobody can review that churn on every spacing change, which is how a visual
  suite becomes a rubber stamp.

## D31: there is no backwards-compatibility burden

The maintainer is the only user and the OSS portion has never been public, so a
contract change needs no major-version discussion, no deprecation window and no
shim — **D15's "remove the shim at 1.0" is free to happen whenever convenient**,
and step 2's S10 stops being a separate step. The `CONTRACT:` prefix and the
`docs/integration-contract.md` update still stand, because they keep the
contract documented rather than protected.

What replaces the old bar, and it is not nothing: there is **one real
deployment** and it must survive a deploy. Server and client ship together; a
stale PWA must fail loudly rather than render a half-broken screen; a forced
refresh or reinstall is acceptable. Lockstep versioning and the release guards
are untouched — they guard a different hazard. Full text in `DECISIONS.md` D31.

This also settles wave 6's sequencing: with no exposure, the ordering is
engineering convenience, so **wave 6 may fix `ui-react`'s renderer registry as
part of itself** rather than waiting for step 2's S1.

## What to do next

**Wave 6 — D3 tool contracts** is unblocked. `ToolComponentContract` in
`ui-sdk` (React-free, server-importable), components typed
`z.infer<contract["payload"]>`, `bind(contract, Component)` in `ui-react`, the
system-prompt append generated from the contract list, and a `CONTRACT:` commit
with `docs/integration-contract.md` in it. It also gets to fix the real bug S1
was going to: `registered` in `components/chat/renderers/index.ts` is never
cleared by `resetToolRenderers()`, so one reset permanently un-registers the
builtins.

Then **step 2** — rewire `ui-react`, reshape the stores (D13/D15).

Three design questions are open and will move screens, and therefore baselines:
two in `design-feedback.md` §14 (a four-tile `StatTiles` row breaking 3 + 1; the
digest saying "Today · 3 items" twice) and one in §16 (pin labels colliding when
two pins are close, and clipping when long — the component cannot measure text
at render time, so every fix is a design decision).

## The method that keeps earning its keep

Every gate added this session was proven by **seeding the bug it claims to
catch** and watching it fail. That is not ceremony — it caught three tests that
were not load-bearing, two of them mine:

- the roving-tabindex hazard stories, which all four caught only because the
  fallback clause was seeded away;
- an anisotropy test that compared two lengths for equality and passed against
  degree-space arithmetic;
- a clip-splitting test whose line had a wholly-outside segment, so a different
  branch split it and the test passed against an implementation that never split
  at a boundary at all.

And twice this session a person looking at Storybook found what the whole suite
could not — a graph rendered as a line, a lane drawn as two runs, a map being
stretched. **Assertions about props, roles, counts and computed styles cannot
see a component that has vanished or a projection that is wrong in both axes at
once.** Wave 7 covers some of that now; the habit of looking still matters.
