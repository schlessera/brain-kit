# Handoff — brain-kit UI design system

Read this first, then `.plan/DECISIONS.md` (the reasoning, D1-D30) and
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
| 6b | MapView coastline geometry (D25) | not started |
| 7 | Visual regression (D10) | not started |
| Step 2 | Rewire `ui-react`, reshape stores (D13/D15) | not started |

Fixtures: the Odyssey world under `packages/ui-kit/fixtures/`, 16 people, 20
places with verified real coordinates, pinned to 2026-07-12, 38 invariant tests.

## How to run it

```sh
bun run test            # whole suite
bun run lint            # six gates, including the leakage gate
bunx tsc --noEmit       # typecheck
cd packages/ui-kit && bunx storybook dev      # the design surface
cd packages/ui-kit && bunx vitest run --project=storybook   # browser tests
bun packages/ui-kit/tools/dc-parity/compare.ts              # DC parity harness
```

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

## The new trap, and it is the biggest one

**Two components were visibly broken in Storybook and passed every test.**
`GraphView` rendered a 2px vertical line for a whole wave — everything inside it
is absolutely positioned, so its intrinsic width is zero and `width: 100%`
against Storybook's shrink-to-fit centred root resolved to nothing. All six of
its stories passed, and none of them *could* have failed: percentages of zero
are all zero. `LaneChart` drew one run as two, against the only argument the
component makes. Both were found by a person looking at the design surface.

`.plan/design-feedback.md` §15. The practical rule: **assertions about props,
roles, counts and computed styles cannot see a component that has vanished.**
Wave 7 is still scheduled last because baselines churn, but that is a scheduling
call, not a statement about its value.

## What to do next

**Wave 6 — D3 tool contracts** is the next feature step, and it is the one with
a `CONTRACT:` commit attached. **Wave 6b** (MapView coastline geometry) is
additive and independent. **Wave 7** is now better motivated than the plan
originally argued; see above.
