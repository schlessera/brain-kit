# Brain Kit · desktop — two layouts and the scale-up rules

Source: `kit/Brain Kit Desktop.dc.html` from the 2026-09-18 design drop (new in
that drop; the kit's `SideRail` and `CommandPalette` were ported in wave 4 from
their component files, before this catalog existed). Three sections, `D1`–`D3`.

The framing: *"Mobile screens answer one question at a time because that is all
a phone can hold. Desktop's advantage is not more room for the same layout — it
is adjacency: the decision and its evidence on screen together, so approving
something never means leaving the thing you were reading. Every component below
is the same file as on mobile; only the frame and the density change."*

Four principles stated up front:

- **Panes, not pages.** A mobile push becomes a third pane. "Nothing is ever
  replaced by a decision — the list stays, the reading stays."
- **Keyboard is the primary input.** ⌘K to reach anything, j/k to move, a/d to
  approve or deny. "Every shortcut is printed where it applies, never hidden in
  help."
- **Hover earns its keep.** Mobile has no hover, so rows show everything. On
  desktop, secondary actions may wait for hover — "but never the item's state
  or its provenance."
- **Measure is capped.** Answer text stops at 720px however wide the window.
  "A 1600px line of prose is not a feature."

## D1 · Chat — three panes at 1440

`SideRail` (208px, expanded, spend `$1.90/5`) · a 300px thread list (serif
"Threads" title, `FilterRow` all/waiting/mine, `ListRow variant="card"` per
thread with icon tone, selected state, `j / k` hint in the footer) · the answer
pane: `ScreenHeader variant="nav"` with no back chevron and a `menu` trailing
icon, a **720px measure** holding `MessageBubble(user)` → `StatTiles` (3 tiles,
`minTile=150`) → `QuoteCard` → `ComparisonTable` → `SuggestionChips`, and a
**320px evidence rail** on the right: `Label "This run"` + `TraceSteps
variant="list"`, `RelatedFiles`, `Label "Waiting on you"` (amber, meta `1`) +
`ActionCard kind="approval"` with `rightMeta="a / d"`. `Composer` across the
bottom with hint `⌘K for commands · ⏎ to send · ⇧⏎ for a new line`.

"The answer pane keeps its 720px measure and the right edge carries the run's
evidence — on mobile that evidence was a collapsed Disclosure; here it is simply
visible, because there is room for it to be."

## D2 · Actions — triage at 1280, with the palette open

`SideRail` collapsed (60px) · a 380px list: "Actions" title with `6 waiting · 2
snoozed` in teal, `FilterRow`, five `ActionCard`s (approval with
`rightMeta="selected"` and a breathing amber foot dot; choose with the purple
provenance chip; dead-letter; quarantined; unverified, struck, snoozed 24d),
footer hints `j / k move · s snooze` · the detail pane: `ScreenHeader
variant="nav"` "Approval / blocks queue item q-4c1 · researcher stopped here"
(amber subtitle), `Callout` (amber, deadline), `Receipt`, `Label "Why it
stopped"` + `TraceSteps variant="rail"`, then **four buttons in a row** with the
key printed in the label: `Approve · a` (primary, effect `enqueue`), `Deny · d`
(danger), `Snooze · s` (quiet), `Make it a rule` (suggest) — all `size="lg"`,
`block={false}` — and an `InlineToast` "Previous decision · filed 2 shared
links · write_note · Undo". Over all of it, a `rgba(8,9,12,.62)` scrim and a
560px `CommandPalette` at 110px from the top.

"Approving here never navigates — the list keeps its place, and the next item
becomes selected."

## D3 · Scale-up rules

The breakpoint table:

| Breakpoint | Nav | Layout |
|---|---|---|
| ≤ 479 phone | TabBar, 5 slots | one pane, pushes |
| 480–899 tablet | SideRail collapsed (60px) | list + detail |
| 900–1279 laptop | SideRail expanded (208px) | list + detail |
| ≥ 1280 desktop | SideRail + ⌘K palette | rail + list + detail + evidence |

The rules, verbatim where it matters:

- **Hit targets ≠ visual size.** "Specify the reach past the paint, never a
  finished box size. Small visuals stay small and expand via a transparent
  `::before` at negative inset, or padding cancelled by equal negative margin —
  and any hairline on such an element is an inset box-shadow, not a border,
  since a pseudo-element offsets from the padding box and a border would eat a
  pixel of reach per side. Expansion per side must be ≤ half the distance to
  the nearest interactive neighbour on that axis. 44px stays the floor on
  touch; desktop rows may drop to 32px, but only where a pointer is the assumed
  input — never in a sheet that also ships on mobile." (This is the design's
  answer to design-feedback §1; see D34.)
- **Type.** Body 13.5 → 13px, meta stays 9–12px mono. Serif titles step up one
  notch per pane width (17 → 19 → 21). "Nothing else changes; the ramp is the
  same ramp."
- **Measure.** Answer prose and chat blocks cap at 720px. `StatTiles` go 3-up
  at 720px and 4-up past 1100px; `ComparisonTable` allows a fourth column past
  1100px, never at 390px.
- **Hover.** Desktop may reveal secondary actions on row hover (open, copy
  path, snooze). "State, provenance and effect chips are never hover-only —
  they are what the row means."
- **Keyboard.** ⌘K palette, 1–5 for destinations, j/k to move within a list,
  a/d/s to approve, deny, snooze, ⏎ to open, esc to dismiss. "Shortcuts are
  printed on the control they trigger."
- **Focus order.** Rail → list → detail → composer. "A resolved decision
  returns focus to the next list item, never to the top of the document."
- **Density of evidence.** What mobile collapses behind `Disclosure`, desktop
  shows: the trace, the files read, the receipt. "Same components, no new
  ones."
- **What never scales up.** One primary action per pane. One ambient
  animation. Two background colours. The effect chip on anything that writes.

## What this settles, and what it does not

- The **keyboard question** (design-feedback §10) gets more evidence but not an
  answer: the design now prints `a / d / s` on the buttons themselves and
  `j / k` in the list footer, which reads as screen-scoped shortcuts, not
  focused-component ones. WCAG 2.1.4 wants them remappable, switchable, or
  focus-scoped, and a `Composer` is always on the same screen. Still open; the
  desktop layouts are where it has to be decided, and they are an app-level
  (step S5+) concern, not a kit one.
- `StatTiles` 3-up / 4-up is a **container** rule, not a component one, and
  the kit's `minTile` already does it. The digest fixture is now three tiles
  (`Brain Kit.dc.html` §12), which is the design's answer to design-feedback
  §14's 3 + 1 wrap.
- Both layouts are pure assembly of existing components: no new kit work. They
  are the spec for the desktop half of D16 when `ui-react` moves onto the kit
  (S5–S7), and the 720px measure, the evidence rail and the four-button row are
  what that migration should reproduce.
