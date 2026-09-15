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
