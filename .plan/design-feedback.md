# Design feedback — defects and gaps found by implementing the kit

Things the port found that need a DESIGNER'S answer rather than a workaround in
code. Each entry states the problem, the measurement or the evidence behind it,
why the obvious fix is wrong, and the specific decision being asked for.

Nothing here has been patched in `ui-kit`. Where a defect ships, it ships as
designed with a test documenting exactly how far off it is — that is the honest
state, and it means the moment the design moves, the test fails and tells us.

---

## 1. Every hit-target expansion on a bordered element is short by its border

**Status:** ships under spec, measured and asserted. Needs a design decision.

### The arithmetic

The design extends a small control's touch target past its paint with a
transparent pseudo-element at a negative inset — a good technique, and the right
one. But **an absolutely positioned pseudo-element is offset from its containing
block's PADDING box, not its border box.** So on an element with an `N`px
border, an `inset: -Mpx` reaches only `M - N` pixels past the visible edge, on
every side.

The design's comments compute the target from the border box, which is the
element's *drawn* size. The two disagree by exactly the border width per side,
so a 1px border costs 2px on each axis.

### What that costs, measured in a real browser

Measured with `elementFromPoint` at each target's edges — not computed, and not
eyeballed — in `FeedbackRow.stories.tsx` and `InlineToast.stories.tsx`.

| Component | Drawn | Border | Design says | **Actually** | Against the 44px floor |
|---|---|---|---|---|---|
| `FeedbackRow` thumb | 30 x 26 | 1px | 48 x 44 | **46 x 42** | **2px under, vertically** |
| `InlineToast` undo | text-sized | 1px bottom | 44 tall | **43.65 tall** | **0.35px under** |
| `Toggle` track | 38 x 22 | none | 44 x 44 | 44 x 44 | meets it |

`Toggle` is correct, and the reason is instructive: its track has **no border at
all**, so its padding box and its paint are the same box and the arithmetic
happens to work. That is why this was not caught when `Toggle` was built — the
one component that got it right got it right by accident of having no border.

### Why the obvious fix is wrong

Widening `FeedbackRow`'s inset from `-9px` to `-10px` gives a true 48 x 44. It
also **reintroduces the click-theft bug the design already hit once.**

The design's own constraint is that expansion per side must be no more than half
the distance to the nearest interactive neighbour — so a `-10px` inset demands
`gap >= 20`, and the design's stated gap is **18**. At 18 the two thumbs'
invisible targets would overlap, the later sibling would win the hit test, and
the row would record thumbs-down for a thumbs-up. That is the exact failure the
design's own note says happened in the first place.

So the inset and the gap have to move together. **A local fix in the kit would
silently diverge from the source's spacing and break the source's own gap rule
at the same time**, which is why nothing was changed.

(The current `inset: -9px` with `gap: 18` is safe: 8px of real reach per side,
16px total, inside the 18px gap with 2px to spare. The component is under-spec,
not broken. `NarrowGapStealsTheClick` reproduces the theft on demand at
`gap: 10`, so the constraint itself stays proven.)

### What the design needs to decide

One of three, for every hit-target expansion in the system — not just these two:

1. **A larger inset with a correspondingly larger gap.** For `FeedbackRow`:
   `inset: -10px` and `gap: 20`. State both numbers together, since changing one
   without the other is the bug.
2. **Borderless hit-target elements.** Express the thumb's rest state with a
   background or a shadow instead of a 1px border, so the padding box and the
   paint coincide and the existing arithmetic becomes true. This is what
   `Toggle` accidentally does and it is the only option that makes the rule
   self-enforcing.
3. **Explicit acceptance** that these two sit slightly under the floor, with the
   numbers written into the spec so nobody re-derives 48 x 44 later.

Whichever is chosen, the general rule is worth stating in the design's own
notes: **specify a hit target as reach-past-the-paint, not as a finished box
size.** Reach is what the pseudo-element actually controls; the box size is a
derived number that depends on a border the spec may not mention.

---

## 2. `ContactCard` cannot express severity in a fact

**Status:** ships as designed. Needs a design answer.

### The problem

`ContactCard`'s facts are the things the corpus can prove about an entity — last
contact, open threads, what they are holding. Several of them are *statements
about a problem*, and the component has no colour to say so.

Its tone table is the **entity** palette: teal a person, blue a company, purple
a project, amber a host, neutral unremarkable. There is no red and no gold. The
fact colours reuse that table, and the lookup has **no fallback** — a fact with
`tone: "gold"` renders with no colour at all and quietly inherits.

### The evidence

This surfaced from narrowing the fact tone to the component's own five, which
turned a fixture naming an unavailable colour into a compile error. Two fixtures
had to be weakened:

| Fact | Wanted | Had to use |
|---|---|---|
| `last spoke: 20 years ago` | red | amber |
| `holding: estate · herds · 108 guests` | gold | amber |
| `standing: unresolved · 10 years` | red | amber |

Three facts that mean three different degrees of "this is a problem" now all
read amber. The card's whole job is to make a relationship's state legible at a
glance, and staleness and load are exactly what it is being asked to show.

### What the design needs to decide

Either:

- **Give facts the full tone set** — the fact row is a different surface from
  the avatar, and there is no reason they must share a palette. This is the
  smaller change and probably the right one.
- Or **state that facts are deliberately unseverable**, and that a fact needing
  red belongs in a different component. If so, say which, because the fixtures
  currently have nowhere to put "you have not spoken in twenty years".

Either way the lookup should get a fallback, so an unlisted tone renders as
something rather than as nothing.

---

## 3. `AgentRunCard` has a fallback that can never fire

**Status:** ships as designed; the unreachable operand is deleted from the port's
source text only. Needs a design answer.

### The problem

`AgentRunCard`'s `renderVals()` writes these two lines next to each other:

```js
progress: p.progress === null ? null : Number(p.progress ?? 72),
showProgress: p.progress !== null && p.progress !== undefined
```

The second line gates the meter on the prop being defined. The first supplies a
fallback for the case where it is not. **They cannot both matter**: whenever
`?? 72` would fire, `showProgress` is already false and nothing is drawn. The
fallback is dead code that reads as live, and it reads as the design stating
that a run without a stated progress is 72% done.

### Why this is worth an answer rather than a patch

The `data-props` block declares `progress` with a default of **72**, and the DC
runtime injects `data-props` defaults as real props — so the standalone catalog
page *does* draw a meter at 72. A React consumer rendering `<AgentRunCard />`
with no props draws **no meter**, because React has no runtime to inject an
editor default. Both are faithful to the source; they just answer different
questions.

So the two lines encode two different intentions and the source does not say
which is meant:

- If a run with no stated progress should show **no meter** — which is the
  honest reading, since a progress bar at a number nobody supplied is a
  fabricated claim about how far along a run is — then the gate is right and
  **`?? 72` should be deleted from the design too.**
- If it should show **72** — matching what the catalog page shows today — then
  the fallback is right and **the gate is the defect**, and it should read
  `p.progress !== null` alone.

The port keeps the behaviour exactly (no meter) and deletes only the unreachable
operand, with a comment pointing here, so that nobody later "fixes" the gate to
reach a fallback that may never have been intended.

### The general shape, because it is not only this component

Twelve props across the kit have a `data-props` default that a propless React
render does not reproduce — `StatusDot.pulse`, `ChoiceOption.selected`,
`ListRow.selected`, `FileRow.active`, `TrendChart.deltaTone: 'red'` and eight
others. D30 rules that this is correct and deliberate: **`data-props` defaults
are catalog defaults**, answering "show me what this looks like", not "what
should this be when unspecified". Nine of the twelve make a component render its
*emphasised* state, and `TrendChart.deltaTone: 'red'` is the proof — as a React
default it would make every un-toned delta read as bad news.

`AgentRunCard.progress` is the only one of the twelve where the source ALSO
carries a fallback, which is what makes it a defect rather than an instance.
Worth a sentence in the design's own porting notes: **a `data-props` default and
a `renderVals` fallback are different things, and a prop should not have both
unless they agree.**

---

## 4. Smaller notes, not blocking

- **`ScheduleList` resolves `neutral` to the `edge` hairline**, `StatTiles` and
  `ComparisonTable` resolve it to **primary ink**, and `SuggestionChips`
  resolves it to **dim ink**. All four are deliberate in the source and all four
  were ported as found, but that is four meanings for one token name in one
  wave. Worth a sentence in the design's Foundations saying that `neutral` is
  contextual, or renaming the three that are not the neutral accent.
- **`ComparisonTable`'s tone table carries a `muted` entry nothing can reach**,
  since `Tone` has no such member. Dead in the source, like `Receipt`'s. Either
  add it to the tone vocabulary or drop it from both tables.
- **`EmptyState`'s `offline` copy named a real VPN product** and could not ship
  in any form — `AGENTS.md` bans personal infrastructure as a category. The
  variant was rewritten. Worth checking the rest of the design's copy for the
  same class of thing before the next drop.

---

# Wave 1b — accessibility

The four contrast findings below are one finding seen four times: **the ink ramp
is measured against a bare ground, and the kit almost never has one.** They are
reported rather than patched because a contrast failure is a palette decision,
and patching one would fork the kit from its source quietly.

Every number is computed from the tokens in
`packages/ui-kit/tests/contrast.test.ts`, not written in prose here, so the day a
token moves a test fails and names what changed. Each is also disabled — the
`color-contrast` rule only, on the specific stories that show it — through
`knownContrastGap()` in `stories/_stage.tsx`, which requires the call site to
state its reason. The a11y gate is at `'error'` everywhere else.

## 4. `opacity` takes a whole row under the floor at once

**Status:** ships as designed, measured and asserted. Needs a design decision.
**This is the widest of the four.**

`QueueItemRow` fades a `superseded` row to `opacity: .7`; `NotificationCard`
fades a `dim` one to `.8`; `ScreenHeader` uses `.7` on a meta line. All three are
the design's own device for "de-emphasised", and all three are correct as
*visual* devices.

But `opacity` renders the subtree to a layer and composites the layer against
the backdrop, so it is not a styling choice that happens to touch contrast — **it
is a contrast change applied to every colour in the row simultaneously**,
including the ones that were only just clearing the floor.

| Where | Fade | Colour | Bare | **Faded** |
|---|---|---|---|---|
| `QueueItemRow` superseded | .7 | ink-mute on surface | 5.09 | **3.08** |
| `QueueItemRow` superseded | .7 | teal-ink on surface | 7.40 | **4.17** |
| `NotificationCard` dim | .8 | ink-mute on its own ground | 5.09 | **3.72** |

The teal row is the one worth looking at twice: teal is not a decorative colour
there, it is the colour that means something, and it goes under the floor with
everything else.

**What the design needs to decide.** De-emphasis has to come from somewhere that
is not opacity, or opacity has to come with a floor. Two shapes that work:

1. **A de-emphasised ink, not a faded one.** Express "superseded" by stepping the
   ink down the ramp — which stays a token, stays measurable, and keeps the
   accents at their own contrast — rather than by fading the composite.
2. **State a minimum.** If opacity stays, name the lowest value the ramp
   tolerates and put the floor in the Foundations. At `.7`, only `color-ink`
   still clears 4.5 comfortably; `ink-dim` is marginal and `ink-mute` is gone.

## 5. `ink-mute` clears the floor on a bare ground and on nothing else

**Status:** ships as designed, measured and asserted. Needs a design decision.

The design states `#8a8691` is 5.10:1 on surface and calls it "the floor". **That
is exactly right** — measured at 5.09 — and it is right only against the bare
surface.

`ink-mute` is the kit's meta colour. It is used at 9-11px. And the kit puts a
tint, a raised ground or a fade behind it almost everywhere it appears:

- Over `raised`: **4.75**. Still passing, with 0.25 of headroom.
- Over **every one of the 81 translucent tints** the kit defines, on `raised`:
  **all 81 fail.** Not a handful — all of them.
- Over those tints on `surface`: 34 of 81 fail.

The instance axe caught is `ChoiceOption`'s detail line on a *selected* option —
4.36:1 — which is every `AskUserCard` story, because every one of them shows a
selection.

**What the design needs to decide.** The floor is real but it is quoted against a
ground the kit does not use. Either:

1. **Move `ink-mute` up** so it clears 4.5 on `raised` plus a 10% tint, which is
   the worst ground it actually meets. That is roughly `#9a96a1`.
2. **Or say that `ink-mute` is for bare grounds only**, and name the colour that
   goes on a tint. Right now there is no such colour, so every component reaches
   for `ink-mute` and lands under the floor.

Whichever: **the floor should be stated against the worst ground in the system,
not the best one.** A floor measured on the one surface that never carries a
tint is not a floor.

## 6. The count chip paints white on a fill built for near-black

**Status:** ships as designed, measured and asserted. Needs a design decision.

`Chip variant="count"` sets `--bk-chip-count-ink` (`#fff`) on the solid tone
fill. On red that is **2.77:1, at 9px** — the widest single miss in the kit.

The cause is structural rather than a bad pick: **every fill in this palette was
chosen to glow against `#0c0e12`**, so white on any of them is the wrong way
round. The design's own answer is already one row up in the same file — a solid
`Button` puts near-black ON the fill, and `#0c0e12` on red-fill is **6.98:1**.

**What the design needs to decide.** Either the count badge takes the canvas ink
like every other solid, or `--bk-chip-count-ink` becomes a per-tone value. The
first is one token deletion and matches what the rest of the kit does.

## 7. A solid button's effect chip is under the floor on every tone

**Status:** ships as designed, measured and asserted. Needs a design decision.
**Axe did not catch this one**, because no story renders a solid button with an
effect chip — which is worth stating plainly, since "axe is green" and "the
palette is sound" are different claims and this is where they come apart.

`--bk-button-ink-on-solid` is near-black at `.62` alpha, which is a mid grey once
composited, and a mid grey on a glowing fill is neither:

| Tone | Effect chip |
|---|---|
| amber | **3.30** |
| gold | **3.60** |
| teal | **3.16** |
| purple | **3.07** |
| blue | **3.31** |
| red | **2.99** |

The label beside it is `--bk-color-canvas` on the bare fill and is fine (amber:
8.46), so the chip is the only thing on a solid button that fails — which makes
it a palette decision rather than a layout one. It is §6 seen from the other
side: the alpha is what costs it.

## 8. The paper theme is a known gap, and it is a large one

**Status:** the design's own known-gaps list already records it. Measured here so
the size is on the record.

`PhoneFrame theme="paper"` renders dark-token components on a light bezel,
because the light theme is specified but not yet wired into the components. The
numbers: ink `#e8e4df` on paper `#f4f0e8` is **1.11:1**; amber on paper is
**1.95**; teal is **2.15**. Nothing to decide — D21 already names routing the
tone maps through `[data-theme]` as the light-theme wave's job. It is listed so
that wave has the measurements to work against.

---

# Wave 1b — semantics and keys

These are not contrast, and they are not all for the designer. Each says who
owns it.

## 9. `FileRow`'s `option` role cannot be made valid, and has been changed

**Status:** DIVERGED FROM THE SOURCE, deliberately. Recorded so a later reader
comparing against the `.dc.html` does not "restore parity".

The source picks the row's role per row: `treeitem` for a folder, `option` for a
file. **No container satisfies both.** `treeitem` requires a `tree` parent and
`option` requires a `listbox`, so whichever one the caller renders, half the rows
are invalid inside it — and no call site can fix that, because the container it
would need does not exist. Axe failed it from both ends at once:
`aria-required-parent` on the file rows and `aria-required-children` on the tree
holding them.

Every operable row is now a `treeitem`, and `aria-expanded` carries the folder /
file distinction the role was carrying. The design's own role-and-keys table says
`button` / `treeitem` for this component and never mentions `option`, so this
also moves the port back towards the spec rather than away from it.

Flag if the design meant a flat file *list* somewhere — that would be a
`listbox` of `option`s with no folders in it, which is a different component and
a fine thing to want.

## 10. Three key bindings in the role-and-keys table have nowhere to land

**Status:** not implemented. Needs a design answer, and there is a standards
reason to want one.

| Table says | Status |
|---|---|
| `ActionCard` — `a` / `d` / `s` | **Not implemented.** The component has ONE handler (`onClick`), so approve / deny / snooze have nowhere to go. |
| `TabBar` — `1`-`5` | **Not implemented.** Arrow keys are wired; the digits are not. |
| `FileRow` — `←→` to fold | **Not implemented,** and already recorded: `kind` is a prop and there is no `onToggle` to route an arrow key to. |

Every one of these components is fully operable without them — Tab reaches it,
Enter / Space / arrows work — so this is missing *shortcuts*, not missing
reachability.

**The reason to ask rather than just build them:** WCAG 2.1 SC 2.1.4 (Character
Key Shortcuts) says a single-character shortcut with no modifier must be
remappable, or switchable off, or **active only while the relevant component has
focus**. `a` / `d` / `s` on a card and `1`-`5` on a tab bar are exactly that
pattern. The third option is almost certainly what the design means — the keys
act on the focused card — but it needs saying, because the other reading (global
shortcuts on the screen) makes every one of these a conformance failure the
moment a text field exists on the same screen. And a `Composer` always does.

## 11. Every `tab` and `radio` in the kit was its own tab stop

**Status:** FIXED. Four components changed, one shared helper, and the two
failure modes it could have caused are each asserted by their own story. No
design answer needed — this was the implementation decision wave 1b deferred,
not a question for the designer.

`FilterRow`, `TabBar`, `SideRail` and `ChoiceOption` each rendered `tabIndex={0}`
on every item. The ARIA pattern for a `tablist` and a `radiogroup` is a **roving
tabindex**: the group is ONE tab stop and the arrow keys move within it. The cost
was visible in `stories/rules/Keyboard.stories.tsx`, which walks a screen
carrying both nav components: **ten tab presses to get past the navigation**
before reaching any content. **It is two now**, and that story's expectation is
still a list of names rather than a count, so it says which stops went.

### The shape of the fix

`src/internal/roving.ts` holds `useRoving(eligible, selected)` and
`focusSibling(from, delta, item, group?)`. The second one replaced four
near-identical copies of the same DOM walk.

The stop is resolved in three clauses, and the third is the one that matters:

1. the last item inside the group that took focus, if it is still eligible —
   this is what makes Tab return you to where you were rather than silently
   undoing the arrow keys you just pressed;
2. otherwise the selected item, if IT is eligible;
3. otherwise **the first eligible item.**

Eligibility is the kit's existing per-item gate. When nothing is eligible there
is no stop at all, which is correct rather than a fallback failure — a group of
decorative items has no tab stops, and `NothingIsReachableWithoutAHandler` still
asserts it.

### Why clause 3 is the whole finding

Getting this half-right is worse than not doing it: a group where nothing is
selected, and whose items are therefore all `tabIndex={-1}`, is not harder to
reach — it is **unreachable from the keyboard entirely**. That is not an edge
case. An `AskUserCard` whose question nobody has answered yet has no selected
option, and it is the common state of the component.

Each of the four has its own story for it, and each was proven by seeding the
naive implementation and watching only those four fail:

| Component | The unreachable case |
|---|---|
| `TabBar` | `AnUnreachableActiveSlotDoesNotStrandTheBar` — the amber slot has no handler |
| `SideRail` | `AnUnreachableActiveRowDoesNotStrandTheRail` — same, vertically |
| `FilterRow` | `AnUnreachableSelectedPillDoesNotStrandTheRow` |
| `AskUserCard` | `AnUnansweredQuestionIsStillReachable` — no option selected |

### `ChoiceOption` needed a different answer, because it is not a group

The other three own their whole group and can hold the state. `ChoiceOption`
cannot: it is a single option and the `radiogroup` is its caller's markup —
the same fact that already stops it rendering the group role. It cannot see its
siblings, so it cannot know whether one of them is already the stop.

So the group owner passes `tabStop`, and `AskUserCard` does. **Omitting it leaves
the option a tab stop**, which is the status quo and is the only safe default: a
component that cannot see its siblings must not assume one of them is reachable.
A hand-rolled group that never passes `tabStop` keeps every key the design's
table specifies — arrow navigation uses `focus()`, which does not consult
`tabIndex` — and pays only the extra stops. `ChoiceOption.stories`' `RovingGroup`
is the hand-rolled equivalent, and says in its own body that a static `tabStop`
buys one stop but not a caret-following one.

`onFocus` was added alongside it, for the same reason: the group owner needs to
know which option the caret is on to keep the stop there.

### Activation: two components, two opposite answers, both already right

`FilterRow` activates on focus — arrowing through filters *is* filtering — and
`TabBar` / `SideRail` do not, because arrowing onto Files must not navigate to
Files. Both were already implemented that way and neither changed.

### One real bug fell out of it

`FilterRow`'s arrow handler fired `items[n]` where `n` was an index into the
**DOM walk**, and the walk only visits items that carry a role — the interactive
ones. In a mixed row the two indexes diverge and arrowing filtered by the wrong
pill. Activation now goes through the element the walk actually focused
(`next.click()`), so there is no index to get wrong.
`ActivationFollowsTheElementNotTheIndex` is the story, and it fails against the
old handler.

### What was deliberately not added

`Home` / `End`, which the ARIA authoring practices recommend for a composite
widget. They are not in the design's role-and-keys table, and D4 makes "no more
than the design" a scope rule. Worth raising with the designer as an addition
rather than shipping as a port.

## 12. A switch has no name, because the design draws it as pure geometry

**Status:** fixed in the kit, with a net-new prop. Worth a design answer anyway.

`Toggle` ported as `role="switch"` with no accessible name, and axe failed it
(`aria-toggle-field-name`). A switch is the one control whose visual carries no
words at all — a button at least has its label — so there is nothing to fall back
on.

`label` (and `labelledBy`, for a switch beside visible text) were added, with a
dev warning when a handler is passed and neither is. The prop is net-new: the
design has no text of any kind on a switch, in any state, anywhere.

The question for the design is whether a switch should ever appear *without*
adjacent visible text. `ListRow`'s toggle has a row title next to it and should
probably use `labelledBy` pointing at it; a standalone switch has nothing, and
`aria-label` is then the only option — which means a name only screen-reader
users get, and those are usually a sign the visual design is missing a label.

## 13. Hover values for a toned `Surface` were derived, not specified

**Status:** derived and documented. Confirm or replace.

`Surface` became operable this wave and needed a hover. D20 specifies hover as
"surface one step up" and shows it only on the untoned card. For the six toned
ones, `--bk-surface-hover-tint-*` steps the tone's own tint by **+0.04 alpha**
(0.05 → 0.09, 0.06 → 0.10), keeping D20's rule that the tone never changes.

The step is deliberately smaller than `--bk-suggestion-hover-tint-*`'s +0.07: a
chip is a small dense mark and a card is a large field, and the same jump that
reads as a lift on a pill reads as a colour change on a panel. Neutral has no hue
to step and resolves to `raised`, which is D20's literal value.

These are the only invented numbers in the wave. If the design has its own, they
are a seven-line change in `theme.css`.

## 14. What wave 5 found by assembling the four screens

**Status:** six findings. Four were kit defects and are FIXED; two need the
designer. All six were found by looking at Storybook — none of them failed a
test, and three of them could not have.

§11 says its four screens are the acceptance test for the component set: *"pure
composition: no new colours, no new type sizes, no bespoke markup beyond
layout."* They are, and the set held — no screen needed a new component. What
assembly surfaced instead were defects in components that each passed their own
stories, because **a component's own stories put it in a container built for
it**, and a screen does not.

### Fixed: `ScreenBody` was crushing its children

A flex column's children default to `flex-shrink: 1`, so the moment a screen
held more than the phone, every child gave up height at once instead of the body
scrolling. It failed as somebody else's bug: a `FilterRow` compressed from 22px
to 14px and clipped the descenders off its own labels, an `ActionCard` swallowed
the last line of its body, and a `margin-top: auto` spacer stopped spacing
because there was no free space to distribute. Three components looked broken;
the container was. `.bk-screen-body > * { flex-shrink: 0 }`.

### Fixed: a screen could render content nobody could reach

`ScreenBody` defaults to `overflow: hidden` because that is what a mockup does,
and on a real screen the clip looks like the end of the content. The morning
digest rendered 420px of schedule, a card and its closing banner below the fold
with no way to scroll to any of it. `unreachable()` in `stories/_stage.tsx` is
the gate: **a screen may not render more than it can reach** — either the
content fits or the body scrolls.

That fix surfaced a second one. A scrolling region with no focusable content is
a region a keyboard cannot scroll, and this kit gates every tab stop on a
handler — so a replayed transcript or a read-only list would strand whatever is
below the fold. axe's `scrollable-region-focusable` caught it. A scrolling
`ScreenBody` now takes `tabIndex={0}`; the wave that removed ten redundant tab
stops does not get to pretend this one is free, and it is still the right trade.

### Fixed: a centred `Button` spilled its own content

`labelWrap` carried `flex: none` when centred, so a Button narrower than its
label plus its effect chip painted the content outside its own box on both
sides. `0 1 auto` — content-sized when there is room, shrinkable when there is
not. `minWidth: 0` was already there and was being overridden.

### Fixed: `ActionCard`'s children had no band of their own

`body` sets `margin-top: 7` and `foot` sets 9; `children` had nothing, so a
button row passed in by a caller sat flush against the last line of the body and
read as part of the sentence above it. The caller could not fix it without a
one-off margin in a screen, which is the thing §11 says a screen must never
need — so it is the card's.

### For the designer: a four-tile `StatTiles` row breaks 3 + 1

§11.1 gives `digestStats` four tiles at `minTile=96`, and at phone width that
wraps to three tiles and then one tile alone on a second row, stretched to full
width. It is the component's documented behaviour ("three up at a phone width,
four past ~1100px") meeting a four-tile fixture, and the lone wide tile does not
read as a peer of the three above it. Either the digest carries three tiles, or
`StatTiles` needs an answer for the remainder.

Second, smaller: `waiting on you` wraps to two lines, which pushes its value
~9px below the other two on its row. Nothing collides, but the row's baselines
stop agreeing.

### For the designer: `Label` + `ScheduleList` say "Today · 3 items" twice

§11.1 puts a `Label text="Today" meta="2 items"` directly above a `ScheduleList`
whose group renders its own `day` and `meta` — so the assembled screen shows the
heading twice, one line apart, and the catalog's count disagrees with the
group's. The port reads the group (three items, not two) because the data is
right and the mockup is stale, but the doubling is a composition the design has
to resolve: either the section label goes, or the group heading does.

### Noted: an effect chip plus a label does not fit a half-width button

§11.3's suggestion card puts `effect="write_policy"` on a `size="md"` centred
Button sharing a row at phone width — about 136px of content box, of which the
chip claims more than half. The chip is the half that must not be abbreviated,
so the label wraps to two lines. It is legible and both buttons match height,
but it is a constraint worth knowing: a labelled effect button in a half row has
roughly ten characters to work with.

## 15. Two components that were broken in Storybook and passed every test

**Status:** both FIXED, both found by a person looking at the design surface.
Recorded together because they make the same argument.

### `GraphView` rendered a 2px vertical line

Every element inside it — the label, the SVG, all eight nodes, the legend — is
absolutely positioned, which makes its intrinsic width **zero**. `width: 100%`
then resolves against a container that sizes to its content, and Storybook's
`layout: "centered"` root does exactly that: the box was waiting for the
container's width and the container was waiting for the box's, and both landed
on nothing. The graph collapsed to a sliver of its own border at full height.

**All six of its stories passed.** Percentages of zero are all zero, so nothing
overflowed, no node escaped its box, the two edge weights were still distinct
and the focus node was still heavier than the rest. There was no assertion that
could have failed, because every assertion was relative to a box that had
vanished.

Two fixes, because there are two mistakes. The component gets a `minWidth` floor
— below it eight labelled nodes pile into an unreadable heap, so a narrow graph
is the correct failure and an invisible one never is. The stories get an
explicit width, which is D28 again: a story about a component that fills its
container owes that container a width. `MapView` has the same all-absolute
interior and is safe only because its footer row is in flow, which is worth
knowing before that row is ever made optional.

### `LaneChart` drew one run as two

A lane whose segments touch — `{start: 0, width: 58}` then `{start: 58, …}` — is
one piece of work that stopped being able to continue. Ported as written, every
segment carried a radius on all four corners, so the solid bar's right cap and
the hatched bar's left cap rounded away from each other and left a notch: two
runs butted together rather than one that started waiting on you. Since the
hatch means *waiting on the user* and that distinction is the whole reason the
chart exists, the seam was reading against the component's only argument.

A continuation now drops its left rounding, reaches back under its predecessor
by exactly one corner radius, and paints behind it. All three are needed: square
corners alone still leave the predecessor's own cap rounding into bare track.

**The shared lesson.** Both defects are invisible to assertions about props,
roles, counts and computed styles, and both are obvious in a screenshot. This is
the argument for wave 7 stated twice, and it is why wave 7 being last is a
scheduling decision rather than a priority one.

## 16. Wave 6b: real coastline, and three MapView bugs it made visible

**Status:** the geometry shipped; three bugs FIXED; one finding needs the
designer. Every one of the three was invisible until there was a coastline to be
wrong about — a pin in an empty graticule is wherever you put it.

### What shipped

Simplified OpenStreetMap coastline for five locations, plus roads for Troy,
through `MapView`'s existing `paths` prop. **2,611 vertices, 11.6 KB gzipped for
all five** — D25 predicted 12.6 KB, and one raster map tile is about 16 KB.
`tools/geo/generate.ts` is committed and re-runnable; the data is committed and
never fetched at test time. `fixtures/geo/LICENSE` carries the ODbL obligation,
which attaches to the JSON and not to the rendered map, and
`tests/geo-fixtures.test.ts` asserts that the npm tarball still contains zero
fixtures rather than trusting it.

The component gained one prop, `attribution`, and it is a prop rather than
something the component infers because `MapView` cannot know where a caller's
`paths` came from. A consumer drawing their own survey has nothing to credit,
and inventing a credit for them would be worse than omitting one. The check that
makes forgetting loud lives in the fixtures test, not in the component.

### Fixed: every overlay was positioned in the wrong unit

The SVG scales to the card's fluid width. The pins, the graticule labels and the
scale bar are absolutely-positioned HTML **placed at the projected SVG pixel**,
which is only correct when the card happens to be exactly `width` wide.
Measured on a 232px card against a 330-unit viewBox: a pin sat 30% of the box
away from the coastline it marked.

It also meant the SVG was letterboxing — the default `xMidYMid meet` scales the
drawing uniformly and centres it, while `px()` and `py()` map longitude and
latitude across the full width and height *independently*, with different
margins on each axis. The projection was already anisotropic; the SVG was not
being told. `preserveAspectRatio="none"` is what the arithmetic already assumed.

And the scale bar, being a fixed pixel length on a drawing that scales, **claimed
a distance the map was not drawn at** on every card that was not exactly 330px
wide. A scale bar that is wrong is worse than no scale bar, because it is the
thing a reader trusts to measure with.

### Fixed: the dot was not on the coordinate

`transform: translate(-50%, -50%)` centred the whole flex row — dot, gap and
label — on the projected point, so **the dot sat half a label away from the
place it marks**: 44px in a 238px card, about 19% of the width. Worse, two pins
with labels of different lengths are displaced by different amounts, so the
distance *between* them was wrong, under a scale bar claiming to measure it.

Nothing caught it because `tests/mapview-projection.test.tsx` reads the `left`
value, which is the row's anchor and was always correct. The gate that catches
it now renders the same scene at two widths and compares the DOT's fractional
position — which is the one thing a single-width render cannot check, and every
existing test rendered at exactly `width`.

### For the designer: two pins close together collide, and long labels clip

The strait puts Scylla and Charybdis 6 km apart at a 9 km span, and their labels
overlap in the middle of the card. Troy's label — `Troy` plus `where it started`
— reaches the right edge at a phone width. The component flips a label to the
left of its dot past 62% of the width, which handles the edge but not the
crowding, and it cannot measure text at render time to do better.

Three possible answers and they are design decisions, not implementation ones:
a label that truncates (the design never does this), a `meta` that drops when
space is short, or a rule that two pins within some distance share one label.
The port picks none of them; the collision is visible in `Blocks/MapView` →
`Default` and `Troy has roads`.

## 17. The map was being stretched, and the fill that made it obvious

**Status:** both FIXED. The distortion was mine, introduced in §16's fix; the
maintainer spotted it in Storybook, which is twice now that a person looking at
the design surface found what the suite could not.

### Land has a fill, and it is deliberately barely there

A coastline stroke says where the edge is and **not which side of it is water**,
which is the first thing a reader needs before anything else on the map means
anything. `MapView` takes a `land` prop — separate from `paths`, because a route
is a line somebody travelled and land is the ground it was travelled over — and
draws it as one `<path>` with `fill-rule: evenodd`, so a lagoon inside an island
comes out as a hole without anyone saying so.

`--bk-map-land` is 6% white. It was set at 3.5% first and that really was
invisible: present in the DOM, correct in the computed style, indistinguishable
from the sky on screen. 6% takes `#101318` to about `#1d1f24` — enough to see an
island, not enough to compete with a 2px amber route across it.

**Islands only.** An island's coastline stitches head-to-tail into a closed loop
and is land beyond argument. A mainland shore enters the bbox on one edge and
leaves by another, and closing that against the viewport is what D25 measured
going wrong on three of five locations. Verified before building: **486 of 486
closed rings across Gozo, Corfu and Ithaca are counter-clockwise**, so OSM's
land-on-the-left convention holds and viewport closure is tractable — but it is
still a second step, and an island filled correctly beside a mainland left as a
stroke beats five maps of which three lie about which side is water.

### The projection was stretching to fill the card

`px()` mapped longitude across the full width and `py()` mapped latitude across
the full height, independently, with different margins per axis. §16 added
`preserveAspectRatio="none"` on the grounds that this was what the arithmetic
already assumed — which was true, and made the drawing faithful to code that was
itself wrong. **A degree of longitude and a degree of latitude stopped being the
same distance on screen**, an island got wider as the window did, and the scale
bar was only ever true east-west.

The fix is that the projection is built for the width the card actually is
(measured, with `width` as the first-paint and server-render fallback), and the
bbox is then **expanded on its short axis** until one pixel is the same distance
in both directions. Expanded, never cropped: cropping to fit would push out a
pin that was the reason for the view. A wider card therefore shows more ground
at the same scale, which is what filling by panning rather than by stretching
means.

Two things fell out of it:

- **`spanKm` now means the span across the WIDTH.** It used to be applied to
  both axes, harmless while each was stretched independently — but with one
  scale, a minimum on the short axis meant the long one showed roughly twice it,
  and a card captioned "18 km" was drawing forty. The caption is the contract.
- **The graticule read stale bounds.** The correction moves the view in mercator
  y, and `step()` was still choosing its interval from the latitude bounds that
  correction was derived from. The span looked like almost nothing and the
  labels piled on top of one another.

### And a unit bug on the way, which is the useful part

The first attempt compared longitude in DEGREES against a mercator y in RADIANS
— out by a factor of 57, and it widened the wrong axis by two orders of
magnitude: 0.05 degrees of latitude drawn 2.9px tall beside 0.05 degrees of
longitude drawn 129px wide. It typechecked and every existing test passed,
because every one of them renders at exactly `width`, where pixels and
percentages coincide and nothing compares the two axes to each other.

`ONE SCALE FOR BOTH AXES` in `tests/mapview-projection.test.tsx` is the gate
that now catches both the original distortion and that unit bug, and it was
proven by seeding each. It recovers metres-per-pixel from the RENDER — across
from the two pins' longitudes and their x positions, down from the same two
pins' latitudes and their y — because the inputs are exactly what was being
computed wrongly.


---

# 2026-09-18 — reconciled against the second design drop

The maintainer imported the updated design (`Brain Kit Light.dc.html`,
`Brain Kit Desktop.dc.html`, a revised catalog and README, and changed
component files — see `FETCH-PROGRESS.md`). This section is the ledger: for
every numbered entry above, what the drop said, and what the kit did about it.
Status words: **RESOLVED** (the design answered and the kit follows),
**PARTLY** (answered in part), **OPEN** (the drop does not address it).

## 1. Hit-target expansion on bordered elements — RESOLVED (D34)

The design took option 2 and stated the general rule in three places (README,
catalog §11, desktop D3): **specify reach past the paint, never a box size; a
hairline on a hit-expanding element is an inset box-shadow, never a border; an
underline is `text-decoration`, never `border-bottom`; expansion is constrained
per axis.** It also rewrote the two components.

Kit: `FeedbackRow`'s thumb is borderless with `box-shadow: inset 0 0 0 1px`
and `.bk-thumb::before { inset: -9px -8px }` — **46×44 measured** by the same
`elementFromPoint` story that measured 46×42 before, which now also asserts
`border-top-width: 0` and that the shadow is inset. `InlineToast`'s undo uses
`text-decoration: underline dotted` and `.bk-undo::before { inset: -16px -10px }`
— **45.65 tall**, asserted above 44 with `border-bottom-width: 0`. The hover
that used to move a border now moves the shadow (`.bk-thumb:hover`) and the
decoration colour (`.bk-undo:hover`). `NarrowGapStealsTheClick` still steals
at `gap: 10`, so the per-axis constraint stays proven.

## 2. `ContactCard` severity — RESOLVED (D33)

"Entity tone vs fact tone … facts take the full set including `gold` and
`red`. A relationship twenty years cold is `red`, not amber. Unlisted tones
fall back to dim." Kit: `ContactFact.tone` is `ValueTone` (every accent plus
`ink` / `dim`), the avatar keeps its own five, and the lookup falls back to
dim. The two weakened fixtures are red and gold again.

## 3. `AgentRunCard`'s unreachable fallback — OPEN

The component file still carries both `?? 72` and the gate. The port keeps its
behaviour (no meter without a stated progress). Still worth the sentence in the
design's porting notes.

## 4. Four meanings of `neutral` — RESOLVED (D33)

The catalog's Foundations gained a ten-member tone vocabulary: `neutral` is
the grey accent everywhere; `ink`, `dim` and `edge` are named for the other
three meanings; every lookup falls back to `dim`; the dead `muted` entries are
gone. Kit: `StatTiles`, `ComparisonTable` and `Receipt` take `ValueTone` and
render `neutral` as the grey accent (untoned values default to ink, ink, dim
respectively, as the component files do); `SuggestionChips` renders an untoned
chip as dim ink on the card edge and `neutral` as the grey accent with a
neutral-hue tint; `ScheduleList`'s untoned rail is the `edge` hairline and
`neutral` is the grey mark, with its own tag-border token. The `EmptyState`
copy note became a README rule ("no real product or vendor names in kit
copy").

**Fixture consequence.** Every fixture that said `tone: "neutral"` to mean
"plain" was audited. The only one that changed meaning was the digest's
`days out` tile (was primary ink, would have become grey): it now carries no
tone and renders as ink, as before. `Receipt` rows that said `neutral` ("run
#4c1 · turn 12", "~$0.02") are machine meta and read correctly as grey now.

## 5. `ink-mute` on tinted grounds — OPEN, in both themes

The light contract restates the floor against the bare surface (`#6e6659`,
5.2:1) and says nothing about tints. `tests/contrast.test.ts` now measures the
light theme the same way and records that ink-mute fails on tinted grounds on
paper too. Same ask as before: state the floor against the worst ground.

## 6. The count chip's white ink — RESOLVED

README: "Text on a solid accent fill is near-black ink … including count
badges, which are the one place the kit had used white (2.77:1 on red;
near-black is 6.75:1)." Kit: a new `--bk-on-fill` token (`#0c0e12` dark,
`#231f1a` light); `--bk-chip-count-ink` now references it; `Chip`, `Button`,
`Composer`, `NotificationCard`, `FeedbackRow`, `TabBar` and `SideRail` read
`on-fill` rather than `canvas` for anything that sits on a fill. The contrast
exception on `Chip/Count` is removed and the story passes the gate. Measured:
6.98:1 on red.

## 7. A solid button's effect chip — OPEN

`Button.dc.html` is unchanged: the effect chip on a solid button still has
its ink at 62% alpha. The light file draws the chip ground as
`rgba(35,31,26,.16)` and does not draw a subtitle, so the light theme inherits
the same gap. The test still asserts the numbers.

## 8. The paper theme — RESOLVED (D32)

Specified in full and wired: `Brain Kit Light.dc.html` §L5's contract is every
`--bk-*` token's light half, `[data-theme]` switches `color-scheme`, and the
whole story suite runs on paper under the a11y gate at `'error'`. The
`PhoneFrame/Paper` story's contrast exception is gone; the story now asserts
that the frame's subtree is light while the document is dark.

## 9. `FileRow`'s `option` role — unchanged, still diverged as recorded.

## 10. Three key bindings — OPEN, with new evidence

The desktop catalog prints `a / d / s` on the approval buttons themselves and
`j / k` in the list footer, and its rules say "shortcuts are printed on the
control they trigger" — which reads as screen-scoped, exactly the reading WCAG
2.1.4 makes a conformance failure with a `Composer` on the same screen. This
is now an app-level question for the desktop migration (S5+), not a kit one.
See `design/desktop.md`.

## 11. Roving tabindex — unchanged (fixed). `Home` / `End` still absent from
the design's table; still not added (D4).

## 12. A switch with no name — OPEN. `Toggle.dc.html` still has no text.

## 13. Derived `Surface` hover values — OPEN. Not addressed; the light theme
derives its hover tints by the same +0.04 step and they are flagged as derived
in `derive-light.ts`.

## 14. Wave 5's assembly findings — PARTLY

The catalog's digest is **three tiles** now, which is the design's answer to
the 3 + 1 wrap, and the kit's Odyssey digest follows (`fixtures/events.ts`). The doubled heading stands
as designed: the `Label` is a section label and the group heading is a date,
and only their counts disagreed, which the drop fixed.

## 15–17. Wave 6b/7 findings — unchanged. MapView pin-label collision (§16) is
still not addressed by the drop.

## 18. New in this drop, and derived rather than decided

Recorded so the designer can replace them:

- **Five dot values.** The contract gives `--amber-dot #c07d12` and the rule;
  gold / teal / purple / blue / red / neutral dots are a 0.55 blend of ink
  toward fill (the mix that reproduces the amber dot).
- **A neutral fill.** The design has none; the kit's solid neutral chip needed
  a ground, `#a59d8f`.
- **263 alpha values.** Every tint or border the light catalog does not draw
  is its dark alpha stepped by +0.07 (tints, fill hue, capped at 0.16) or
  +0.05 (borders, ink hue). The 55 it does draw are used verbatim. The split is
  visible in `packages/ui-kit/tools/theme/derive-light.ts`.
- **Solid button borders.** The light catalog draws `#d08f2e` on amber and
  `#4aa593` on teal; the kit tokenised them (`--bk-button-border-primary` /
  `-affirm`) so the dark theme keeps its fill-coloured border.
- **Hover lifts on paper.** `amber-lift` / `teal-lift` keep their dark values
  (a lighter fill with `on-fill` on it still passes); the design does not draw
  a hovered solid button in light.

## Baselines

Regenerated in the pinned container after all of the above landed; the four
screens also have light baselines now. Never regenerate on the host.

## 19. The light palette is stated against the surface and has no headroom on the canvas — RESOLVED the same day

**Status:** RESOLVED. The design revised the palette within the day: the
README's table is now stated against "the worst real ground — a 12–16% accent
tint over canvas", and §L5 gained the rule ("State the palette against its
worst ground") and its companion ("Tinted cards may sit on canvas" — the
surface-wrapper alternative was rejected because approval cards sit directly on
the canvas in Actions, Chat and the digest). Ink-meta `#6e6659` → `#5f584c`,
amber `#94580a` → `#7f4c08`, gold `#795c0d` → `#6f540c`, blue `#1f6d96` →
`#1a5c7f`, red `#b8362f` → `#a52e28`; teal, purple and every base and fill
value unchanged. The kit regenerated from the revised contract, the light
Vitest project runs the FULL a11y gate again (the one-day contrast exception is
deleted), and `tests/contrast.test.ts` now asserts what the revision claims:
every accent ink on every tint of its own hue over the canvas, and ink-meta
over every tint, clear 4.5. As a side effect §5 is solved on paper: ink-mute
clears every tint over the surface there, which is the §5 argument — state the
floor against the worst ground and the better grounds follow — demonstrated.
The measurement below is kept as the record of what forced the revision.

`Brain Kit Light.dc.html` §L1 says its ratios are "measured against light
surface `#f8f5ef`" and the README's table calls the same column "on canvas".
They are not the same ground, and the difference is the whole finding. A
screen's ground is the **canvas** (`#ece7dc`); cards sit on it and carry
tints. Measured there (`tests/contrast.test.ts`, "§19"):

| Ink | On surface (design's claim) | **On canvas** | Over the 12% approval tint on canvas |
|---|---|---|---|
| `ink-meta` `#6e6659` | 5.20 | **4.59** | **4.26** |
| `amber` `#94580a` | 5.27 (quoted 5.3) | **4.65** | **4.32** |
| `blue` `#1f6d96` | 5.24 (quoted 5.3) | **4.62** | 4.3 on a teal column |
| `red` `#b8362f` | 5.35 | 4.72 | **4.38** |
| `teal` `#1a6b5b` | 5.85 | 5.16 | passes |
| `gold`, `purple` | 5.76 / 5.96 | 5.08 / 5.26 | pass |

So on paper, **every tint in the kit takes `ink-meta` under 4.5 over the
canvas** — not a proportion this time, all of them — and the two inks the kit
uses most after it, amber and blue, go under on their own tints at 12% and
above, including values the design itself draws (the approval card at
`rgba(224,159,62,.12)`, the active filter pill at `.16`). Running the full
story suite on paper with the a11y gate at `'error'` fails **141 of 543
stories, all on `color-contrast`**, once the two derivation mistakes that were
the kit's own were fixed (a rail ground one step too dark; dot values used as
tag text).

**What the design needs to decide.** The same shape as §5, and it is the same
finding: the floor is stated against the best ground in the system. Either:

1. **Restate the light ramp against the canvas** and darken the three inks
   that need it — roughly one notch on `ink-meta`, `amber` and `blue` (each
   needs about 0.1 more contrast on the bare canvas to survive a 12% tint).
   `teal`, `gold` and `purple` already have the room.
2. Or **say that tinted cards carry the surface, not the canvas** — i.e. a
   tint is composited over `#f8f5ef`, and a card is always a raised thing on
   the canvas rather than a tinted patch of it. That is a layout rule the kit
   can follow, but it is not what the light catalog draws today (its cards sit
   directly on the `#ece7dc` panel).

**What the kit does meanwhile.** The values stay the design's. The light
Vitest project runs every story on paper with every axe rule except
`color-contrast` (a project-level define, `.storybook/preview.ts`, so it cannot
leak into the dark run, which keeps the full gate). The numbers live in
`tests/contrast.test.ts` so that the moment the palette moves, the test fails
and says by how much — and the moment it clears, the exception can be deleted
and the light run becomes the proof it was built to be.

## 20. Two stacked tints of one hue take teal and purple under on paper — small, needs a design answer

**Status:** ships as designed; one story carries a contrast exception.

The revised light palette is stated against ONE tint over the canvas. Teal
(4.5 on that ground) and purple (4.6) have no room for a second: a soft
`Chip` inside a teal-tinted `Surface` on the canvas — the `Primitives/Surface
→ Nested` story — measures teal ink 4.32:1 on `#c5dacc` and purple ink 4.39:1
on `#d3d5d4` at 10.5px. The amber chip beside them survives the stack. The
dark theme passes the same story.

Nothing else in the suite stacks a tint on a tint, so this is a composition
rule rather than a palette fault: either the design says a toned chip on a
toned card is not a composition the kit makes (and the kit can lint for it),
or teal and purple come down one more notch. Until then the story carries
`knownContrastGap` and this section is its reason.

---

# The fourth drop — 2026-09-18, the answers

The maintainer forwarded the open questions to the design as one prompt; the
design answered every one of them in the same day, in a drop that touched all
59 component files (one palette move reaches everything) and rewrote the
README, the catalog's §11 tables, the desktop's D3 rules and the light file's
§L1/§L5 (now generated from one `PALETTE` object, "because a hand-maintained
table drifts from the contract every time a value moves — which is how five
fill rows and both neutral steps went missing"). Statuses:

## 3. `AgentRunCard`'s unreachable fallback — RESOLVED

`?? 72` is gone from `renderVals()`; the comment says what the port had
decided: "a run that does not report progress draws no meter, because
inventing a percentage fabricates agent state. The data-props default is an
EDITOR SEED." The README's porting notes carry the general rule (D30 in the
kit's own words). No kit change.

## 5. `ink-mute` on tinted grounds — RESOLVED, in both themes (D35)

The dark floor moved: **`#8a8691` → `#9a96a1`**, "6.26 on surface, 5.83 on
raised, 4.80 on the worst documented tint (4–10% of any fill over either
ground)". The same correction the light palette needed, applied to dark.
Kit: one token pair in `tokens.ts` (`color-ink-mute`, the three `neutral-*`),
the neutral rgba hue, and every dark baseline. `tests/contrast.test.ts`
measures it: ink-mute clears 4.5 on all 76 translucent tints over both
`surface` and `raised` (it failed 81/81 over raised before), and the selected
ChoiceOption detail line that axe caught at 4.36 is at 4.8+.

## 4. `opacity` — RESOLVED by removal

"No `opacity` de-emphasis … a superseded row is not lower-contrast at all. It
reads as superseded from its state word and its still, neutral dot, at full
ink contrast. The only surviving opacity is `.45` on a disabled control."
Kit: `QueueItemRow` no longer fades; both story exceptions are gone.
`NotificationCard`'s `dim` variant still carries `.8` (it is a lock-screen
mock, and the design file still draws it that way) — recorded in the test.

## 7. A solid button's effect chip — RESOLVED

"A well over a fill **lightens** it (`rgba(255,255,255,.28)`): a dark well
sat at 4.99–6.18, the light one reaches 9.26–12.25", and the subtitle on a
solid button is opaque `on-fill` at weight 500. Kit: `button-ink-on-solid`
is `#0c0e12` / `#231f1a`, `button-effect-bg-on-solid` is the white well in
both themes, `Button`'s subtitle is weight 500. The test asserts the chip
clears 9:1 on every tone (was 2.99–3.3).

## 10. Keyboard scope — RESOLVED (D36)

"Single-character keys are focus-scoped. `a` / `d` / `s` fire only while the
ActionCard they belong to holds focus, and are printed on that card's own
buttons; `j` / `k` only inside the focused list, printed in its footer. WCAG
2.1.4 bars an always-live unmodified single key, and a Composer sits on every
screen — a screen-scoped `a` types into it. Global commands take a modifier:
⌘K for the palette, ⌘1–⌘5 for destinations. Settings carries an off switch
for single-key shortcuts." Plus the focus rule: "a resolved card hands focus
to the next card in the list; if it was the last, focus moves to the
`EmptyState` heading, which is focusable for exactly this reason." App-level;
the kit's part is `EmptyState`'s heading (`tabIndex=-1`, `role=heading`, a
`focusTitle` prop) and the printed keys, which are labels.

## 11. `Home` / `End` — RESOLVED

"Wherever a roving tab stop exists — FilterRow, TabBar, SideRail,
CommandPalette, the ChoiceOption radiogroup and the file tree. They were
missing from the table rather than deliberately absent." Kit: `focusEdge` in
`internal/roving.ts`, wired in all six (FileRow also gained ↑↓ between
sibling `treeitem`s, which it had lacked). Every arrow-key story asserts the
edges.

## 12. A switch with no name — RESOLVED

"`Toggle` always carries a name … inside a `ListRow` it is `aria-labelledby`
the row's visible title (the row emits a stable id); standalone it takes
`label`. There is no Toggle without adjacent visible text." The source falls
back to the literal string `'Toggle'`; the kit keeps its dev warning instead,
which is stricter. `ListRow` now emits the id and passes `labelledBy`; the
catalog's three bare toggles gained visible labels.

## 13. `Surface` hover — CONFIRMED, one delta

The dark values the kit derived are exactly the design's (+.04 alpha per
tone, neutral → raised). Paper "uses the same deltas over its lighter tints":
the generator's +0.07/0.16 cap had produced .16 for every hue where teal,
purple and blue tint at .13 and want .17 — three `SPECIFIED` overrides now.

## 16. MapView label collisions — RESOLVED

"Clustering, never truncating." A pin within `clusterPx` (34) of a placed pin
is absorbed; the survivor's label gains `+N`; `meta` is dropped past 70% of
the width. Kit: ported as the design's two passes, `clusterPx` is a prop,
`tests/mapview-projection.test.tsx` covers the cluster, the meta drop and the
override.

## 18. Derived values — mostly decided now

- **Dots:** all seven are stated (`amber #b06d10`, `gold #9b7610`, `teal
  #227f6c`, `purple #7a5fb0`, `blue #22719b`, `red #bd3b33`, `neutral
  #847c6f`), judged against the 3:1 non-text bar on canvas; "a first pass sat
  at 2.10–2.94 and had to come down". The kit's 0.55 blend is gone. Note the
  amber dot moved from `#c07d12`.
- **Neutral fill** (`#a59d8f`) is still the kit's — the design has none.
- **Alpha values:** still derived by rule, now 252 of 319.

## 20. Stacked tints — RESOLVED

"Teal, purple and red measured 4.24 / 4.32 / 4.41 there and came down a
notch: **teal `#15594c`, purple `#5d4489`, red `#9c2a24`** (now 5.45 / 5.27 /
4.81 stacked). The alternative — linting the composition out — was rejected."
`Surface/Nested` carries no exception; the light project runs the full gate
with none.

## 21. Three small things the drop says twice, differently

Recorded, not blocking:

- The light file's §L5 alias list gives `well-on-fill` as `rgba(12,14,18,.18)`
  in dark, while `Button.dc.html` and the README rule draw the dark well as
  `rgba(255,255,255,.28)`. The kit follows the component and the rule (the
  alias reads like the pre-answer value left in a table).
- The README says the `EmptyState` heading is focusable; `EmptyState.dc.html`
  does not mark it. The kit does (`tabIndex=-1`).
- `Toggle.dc.html` falls back to the name `'Toggle'` when neither `label` nor
  `labelledBy` is given, which satisfies axe with a name that says nothing.
  The kit keeps the warning.

## Baselines

All twenty visual baselines regenerated in the container: the ink move
touches every dark screenshot. 544 stories on dark, 544 on paper, no
exceptions left in either project.


---

# The fifth drop — 2026-09-19, the desktop and the navigation

The maintainer forwarded eleven questions (the desktop ladder, the rail's
five, the palette's contents, the location map, snooze, focus after the last
decision, the off switch, the composer, the More menu, three palette values,
and where §10's components belong). The design answered all eleven in one
drop. Statuses, and what the kit and the app do about each:

## 1. Desktop screens for Files, Activity and Settings — DRAWN

`Brain Kit Desktop.dc.html` D3–D6, all at 1440 or 1280, and D7 restates the
ladder with one new rule: **a four-pane screen needs 1440**; at 1280 a screen
gets rail + list + detail only. Pane contents per screen are in
`design/desktop.md`. Files' evidence rail holds frontmatter (`Receipt`) then
backlinks (`RelatedFiles`) then provenance (`Callout mono`); Activity is the
Actions pane on its `done` filter with the run's `TraceSteps(list)` on the
right; Settings is a 216px section column with the form at a 720 measure;
Graph keeps the app's WebGL canvas and takes kit controls, a `ContactCard`
node card and an `EmptyState` whose emptiness is a finding.

## 2. The rail's five — ANSWERED: Chat · Actions · Files · Graph · Settings

Activity is not a destination: it is the `done` lens of Actions, whose
`FilterRow` is `needs you · running · done`. Actions keeps its own pane even
though approvals also appear inline — the transcript copy and the Actions row
are the same item in two places, and resolving either resolves both. Graph is
a destination, not a Files mode, and ⌘K reaches it too. The phone bar is the
same five with Settings folded into More (a kit `BottomSheet`, docked, holding
Settings plus the acts: Sessions, Sync, Daily briefing, Brain statistics).
New chat is not a slot: it is the primary action in the Chat header and a ⌘K
command. **App consequence:** the Activity page becomes the Actions page with
the filter; the rail and the bar re-map; the More menu becomes a sheet.

## 3. The palette's contents — ANSWERED, with two new row kinds

Groups are what ⏎ *does*: Jump to (New chat, Sessions, a file, a graph view),
Ask (Search, Statistics, a question), Run (Sync, Daily briefing, Add a note).
Sync carries `effect: sync`; the briefing carries a **cost chip** `~$0.12`
(spending is an effect even when nothing is written); Add a note is bare. A
command the host cannot serve is **shown disabled with the mono reason**,
never omitted. The query is a **real `<input>`**. Kit: `PaletteItem.cost`,
`PaletteItem.why`, `onQueryChange`, scrolling list, combobox semantics.

## 4. The location map — ANSWERED

Span = `max(1.6 km, 6 × accuracy)`, stated as a max. The uncertainty is drawn
as a ring at true scale (10% amber fill, 45% hairline), not below 14px
across. `note` renders inside the card under a hairline, in Jakarta. 420px
cap confirmed as `maxWidth`. Kit: `MapView.accuracyM`, `note`, `maxWidth`.
The app's own `spanFor`, note line and wrapper go.

## 5. Snooze — ANSWERED: none on a blocking approval

Blocking kinds (`approval`, `choose`, `dead-letter`, `quarantined`): `a` / `d`
only; the third button is "Always allow", which **deliberately has no key**
(a letter that grants standing permission by reflex is the one footgun in the
vocabulary) and prints its `write_policy` effect chip instead. Non-blocking
kinds (`fyi`, `suggestion`, `unverified`): `a` · `d` · `s`. The kit's keys
table now reads `a / d while focused · s only if nothing blocks`.

## 6. Focus after the last decision — ANSWERED, one correction to the app

Transcript → the composer (confirmed). A list or inbox section → the section
is **replaced by `EmptyState` and its heading takes focus, with the
`InlineToast` receipt above it**; the page heading is the fallback only where
no empty state can exist. The app's inbox currently drops to the page
heading and must change.

## 7. The off switch — CONFIRMED, one ruling

Settings › **Input**, beside Appearance, kit `Toggle`, the copy as shipped.
When off, the printed keys disappear (as shipped). D5 draws the Input section
as a `Surface` of group `ListRow`s with toggles plus a neutral banner
`Callout` explaining the rule.

## 8. The composer — ANSWERED: kit-owned

Row order attach · field · mic · send/stop; capture is a **menu** behind
attach; the provider picker is a mono chip in the hint line; recall chips sit
above the field; `state` (ready · streaming · reconnecting · offline) drives
placeholder, hint and the trailing control together, with the offline reason
printed and the draft kept. Kit: `Composer.state`, `provider`/`onProvider`,
`recall`/`onRecallRemove`, `onStop`, `blockedWhy`. The app's own
`ComposerView` retires in favour of the kit component plus an app-owned
attach sheet.

## 9. The More menu — ANSWERED: the kit `BottomSheet`, docked

Settings plus the acts. Not drawn as its own catalog figure yet (known gap).

## 10. Three values — CLOSED

Neutral fill on paper `#a59d8f` (the kit's value, now stated); `well-on-fill`
`rgba(255,255,255,.28)` in both themes (the kit followed the component;
the light table was wrong); `Toggle` has no fallback name (the kit warns
and the gate fails, as it already did).

## 11. §10 components on the screens — ANSWERED: one closing row per answer

Chips while it is the live answer, `FeedbackRow` once you have moved past
it; the two never stack. The §12 chat screen ends in `SuggestionChips`; the
weekly review carries the `InlineToast` receipt for the last policy written
under the card asking for the next one. Kit screens follow.

## Not followed, and why

- **⌘N for New chat** (the palette's default row prints it): the browser owns
  ⌘N / Ctrl+N and a page cannot intercept it in Chrome. The app prints no key
  on New chat; it stays a header action and a palette row.
- **Inbox undo.** The receipt after a dismissal cannot offer undo until the
  activity API has an un-acknowledge; until then the toast states the effect
  without an undo control (`InlineToast undoLabel=""`).

# The sixth drop — 2026-09-19, the rulings

The maintainer forwarded twelve questions (the ones the fifth drop left open
plus what implementing it found). The design answered all twelve as rulings
in the README ("Sixth pass — rulings") and one new rule ("Where truncation
is allowed"), with catalog §13 drawn for the first two and D3/D6 amended.
Eight files changed: `README.md`, `AskUserCard` (three states, the Other
field), `MapView` (the 110–260 height clamp), `InlineToast` (the target
wraps), `FileRow` and `TraceSteps` (`title` on the ellipsised span), `Brain
Kit.dc.html` (§13), `Brain Kit Desktop.dc.html` (D3 rail rule, D6 colour
modes). Statuses, and what the kit and the app do about each:

## 1. `ask_user` — ANSWERED: an exchange with three states

`AskUserCard` gains `state`: `pending` (options, one focus stop) ·
`answered` (the chosen answer in mono teal, the alternatives GONE, not
dimmed — "they were never the record") · `typed` (the user answered in the
composer; the card quotes what it took, neutral border). All three stay in
the transcript at full contrast; nothing rolls up. "Other" opens a real
field in place of the Submit row. Kit: the prop and the stories. App: the
hand-drawn card with its collapsed summary row retires for the kit card,
and a composer send while a question is pending becomes the answer rather
than a new message.

## 2. `request_image_mask` — ANSWERED: a receipt, not a path

The source thumb (hatched, never a remote image inline) with the drawn
region over it in teal, stacked ABOVE a `Receipt` (region · covers · source
· mask). Failure is a fact in a red mono `Callout` — "no mask drawn ·
dismissed after 2 prompts — the agent continued on the whole image and said
so" — not a dialog. The app renders what its result actually carries and
no more.

## 3. The Files rail — ANSWERED: the column stays, both controls are features

(a) A rail with one block is correct; each block is independent and absent
without data, but the column never collapses ("a pane count that changes
as you click through files is worse than a sparse rail"). (b) Stale needs
only `mtime` and a threshold — build it. Untrusted needs the provenance
record — drawn but disabled with its reason until it exists, the palette's
own rule. Neither is dropped.

## 4. Dismissal without undo — ANSWERED: no toast

As-is rejected (a receipt whose point is undo, shipped without undo,
"teaches that the kit's receipts are decorative"); two-step confirm
rejected. Dismissal is silent — the row leaving the list is the receipt —
until un-acknowledge exists. The app keeps the receipt for approval
decisions, whose effect happens in the run, out of sight: the ruling's own
criterion for a toast.

## 5. New chat keeps no key — BLESSED

"A shortcut you have to look up is a menu item with extra steps." ⌘K, type
"new".

## 6. Unknown cost says `spends` — BLESSED, as a vocabulary

`~$0.12` with an estimate · `spends` without · no chip when the command
cannot spend. Never `$0.00`, never blank. Gold in both cases. The app
already does this.

## 7. The graph caption — CONFIRMED, and entity joins the modes

The caption names the active rule ("a caption bound to a constant while
the control says otherwise is a lie in a legend"). Entity type becomes a
fourth colouring mode (topic · distance · folder · entity), because it is
the mapping shared with `PathRef` and inline mentions; the legend redraws
per mode. D6 adds `Label "Colour"` + `FilterRow`.

## 8. Fold keys — ANSWERED: bind and print

`← →` fold on `treeitem` rows, printed in the D3 footer beside `j / k`.
"An unadvertised key is one nobody uses; an advertised key that does
nothing is worse — so they ship together." Kit: `FileRow.onFold`.

## 9. The closing row flips on the next user message — ANSWERED

Not scroll, not a timer, not never. The app has no suggestion chips or
feedback row on answers yet; the trigger is recorded for when it does.

## 10. Map aspect — BOUNDED

A card is at most 420 wide and its viewport 110–260 tall, clamped in
`MapView`. An envelope of 1.5× wide by 1.0× tall covers every card; the
generator's symmetric 2.4× shrinks to it and all six fixtures regenerate.

## 11. Neutral fill and the alphas — BLESSED

`#a59d8f` paper / `#9a96a1` dark, and the derivation rule is the design:
tints are the fill hue at 8–14%, a toned card's hover +.04, a chip +.07, a
well over a fill `rgba(255,255,255,.28)` in both themes, borders on tinted
grounds the ink hue at 25–40%. "Anything a rule cannot produce is a mistake,
not a value — report it rather than adding it." Nothing to change; the
generator's `SPECIFIED` table stays the only place a light value is typed.

## 12. Three more screens, in order — ANSWERED

Actions triage (phone) · File viewer (phone) · First run. The remaining
thirteen are reference only. Built as stories in the screens group.

## New rule: where truncation is allowed

The line is whether the row IS the record (`InlineToast`, `MapView` labels,
`QuoteCard` citations, a `Receipt` value: never truncate, wrap or cluster)
or OPENS the record (`FileRow`, `TraceSteps`, `SearchResultCard`, `ListRow`,
palette rows: ellipsis allowed, carried as `title`). A `Receipt` value column
under ~160px means change the layout, not the break rule — which is why §13
stacks the thumb above the receipt.

# The app shell on paper — 2026-09-19

## 14. The graph and mermaid palettes have no paper set — OPEN

D39 put the app shell on the kit's tokens, so every surface, border and
text colour in the app now follows `[data-theme]`. Two things still carry
literal colours because they are drawn outside the DOM and were validated as
sets against `#0c0e12`: the sigma canvas palettes (eight categorical slots in
CVD order, the five-step distance ramp, the four maintenance lenses) and the
mermaid theme variables. On paper the canvas is `#ece7dc` and the labels
take the ink, and the node colours are still the dark set — readable, but
never run through the dataviz validator against paper, and the light end of
the distance ramp (`#b7d3f6`) is close to the canvas. Question for the
designer: a paper set for the eight slots and the ramp, in the same slot
order (the order is the CVD mechanism), or a rule that says the dark set
stands on both grounds.

Also for the record, not a question: the app's prose block had four alpha
tints typed as `rgba(224,159,62,…)`. They are `color-mix()` of the amber
ink now, which follows the rule stated in §11 for a decoration on a ground
("borders on tinted grounds the ink hue at 25–40%") — but a link underline at
30% and a table-row hover at 3% were never in the design's list, so they are
derived, not designed, like the 264 in §18.
