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


---

# The fifth drop — 2026-09-19: six layouts, and the navigation settled

Source: `kit/Brain Kit Desktop.dc.html` as re-fetched 2026-09-19 (21 KB →
49 KB). D1 and D2 are unchanged; D3–D6 are new; D7 is the scale-up section,
renumbered. The README's Desktop, Navigation, Palette and Composer sections
carry the rules in prose; this digest is the pane-by-pane spec the app
migration reproduces.

## The new pane rule

**A four-pane screen needs 1440.** Rail + list + detail + evidence at 1280
leaves the detail ~350px, narrower than a three-button decision row (D4's row
measured 519px and sheared its `write_policy` chip). So D1, D3, D4, D6 are
drawn at 1440; 1280 gets rail + list + detail (D2 with the palette, D5 with
its section column). Any decision-button row carries `flex-wrap`; a
`FilterRow` in a 272px pane fits three pills, not four. Above 480 the user may
collapse the rail at any width and it sticks; the ladder sets only the
default.

| Screen | Rail | List | Detail | Evidence rail |
|---|---|---|---|---|
| D3 Files, 1440 | active 2 | 300px: serif "Files" + `4,812 docs` meta, `FilterRow` (all / notes / talks / …), `FileRow` tree (folder rows with `meta` counts, `flag`/`metaTone` gold for stale, the open file `active`), footer `j / k move · ← → fold` | `ScreenHeader nav` (path as title, `2.1 kB · edited 4m ago by researcher · 1 pending edit`, amber subtitle, no back, `menu` trailing) · 720 measure: serif title, amber `Callout` (contradiction + pending edit), prose with inline entity mentions, `Label "Pending edit"` amber + `DiffBlock boxed` | 320px `#0e1014`: `Label "Frontmatter" scope · 7 keys` + `Receipt` (rows, keyWidth 72) · `Label "Linked from" files teal · 4 backlinks` + `RelatedFiles` · `Label "Provenance" secure` + `Callout boxed mono neutral` (git · hash · host · date) |
| D4 Activity, 1440 | active 1 | 360px: serif "Actions" + `41 runs today · $1.90`, `FilterRow` active 2 (`needs you · running · done`), `Label "Needs you" approval amber · 2` + `ActionCard`s (dead-letter `rightMeta="selected"`, fyi `rightMeta="d"`), `Label "Runs" activity · today` + `AgentRunCard`s (`progress={null}`) + `QueueItemRow scheduled`, footer `j / k move · d dismiss` | `ScreenHeader nav` (run name, `run #… · dead-lettered 06:10 · backoff exhausted` red) · 720 measure: red `Callout`, `Receipt` (footnote "no partial writes · the ledger is untouched", keyWidth 84), `Label "Attempts on elapsed time" steps · 3` + `LaneChart`, button row `flex-wrap`: `Retry now` primary lg `enqueue` · `Dismiss · d` quiet lg · `Quarantine the source` danger lg `write_policy` | 300px: `Label "Trace" steps · attempt 3` + `TraceSteps list` · `Label "What it was holding" thread · 1` + `QueueItemRow failed` · `InlineToast` "Last decision · ledger_sync · enqueue" amber with Undo |
| D5 Settings, 1280 | active 4, width 188 | 216px section column: serif "Settings", rows of `Icon` + label + mono meta (Appearance & input, Models, Skills, Security, Devices & agents …), footer `brain.local · v0.1` / `4,812 docs indexed` | `ScreenHeader nav` ("Appearance & input", "applies on this device only", no back, no trailing) · 720 measure: `Label "Appearance" settings` + `Surface pad=0` of group `ListRow`s (Theme `value=system`, Density `value=comfortable`) · `Label "Input" capability` + `Surface pad=0` (Single-key shortcuts `toggle` amber with the mono hint as `subMono` subtitle · Hold to talk `toggle` · Ask before writing files `toggle`) · neutral banner `Callout` "Turning single-key shortcuts off also removes the printed keys from buttons — a key that no longer fires should not be advertised." · `Label "Spend" wallet · this month` + `Surface label="Ceiling"` with `Meter bar` + `BarList` | — |
| D6 Graph, 1440 | active 3 | 264px controls: serif "Graph", `Label "Mode"` + `FilterRow` (modes), `Label "Direction"` + `FilterRow` active 2, `Surface pad=0` (Depth `value="2 hops"`, Mark stale `toggle` amber, Untrusted only `toggle` purple), mono footer `34 of 4,812 nodes drawn` / `2-hop · both directions` | `ScreenHeader nav` ("Around Nordwind", `company · 34 nodes · 2 hops`, `search` trailing) · the app's canvas (kit `GraphView` stands in at `minHeight 560`) with a mono caption `canvas is app-drawn (WebGL) · colour = entity type · click a node to load its card` | 340px: `Label "Selected node" capability` + `ContactCard` with actions · `Label "Edges" files teal · 9` + `RelatedFiles` |

The graph's empty state, drawn beside D6 at 520px: `EmptyState no-results`,
title "Nothing links to this yet", body "This note has no edges in either
direction. Ask a question that mentions it and the graph fills in as the
answer cites things.", meta `0 edges · indexed 4m ago`, primary "Ask about
it" (`ask`), pad 22. "Emptiness is a finding" — no reassurance copy.

## Navigation, settled (D37)

**Chat · Actions · Files · Graph · Settings**, ⌘1–⌘5, same order on the rail
and the phone bar. Activity is not a destination but the `done` lens of
Actions (`needs you · running · done`); D2 and D4 are one screen with the
filter moved, and inbox items pin above the run log. Actions keeps its own
pane although approvals also appear inline: the transcript copy and the
Actions row are the same item in two places. Graph is a destination and a ⌘K
target ("you almost always want the graph *around something*"). The phone bar
folds Settings into More — the kit `BottomSheet`, docked, holding Settings and
the acts (Sessions, Sync, Daily briefing, Brain statistics). New chat is the
primary action in the Chat header and a ⌘K row, never a slot.

## The palette's contents

Groups by what ⏎ does: Jump to (New chat, Sessions, a file, a graph view) ·
Ask (Search the brain, Brain statistics, a question) · Run (Sync `effect:
sync`, Daily briefing `cost: ~$0.12`, Add a note bare — the form's submit
carries `write_note`). Unservable commands are shown disabled with the mono
reason ("needs the host"), never omitted. The query is a real `<input>`.

## The composer, kit-owned

attach · field · mic · send/stop. Capture is a menu behind attach
(`BottomSheet` on phone, popover on desktop). Provider picker: a mono chip in
the hint line. Recall chips above the field. `state` drives placeholder, hint
and trailing control: ready (amber send) · streaming (red stop, field still
typeable) · reconnecting (send live, queues locally) · offline (send disabled
with the reason, draft kept).

## Smaller rulings

Snooze: none on a blocking card; `s` only on `fyi` / `suggestion` /
`unverified`; "Always allow" has no key and prints `write_policy`. Focus
after the last decision: composer in a transcript; in a list, the drained
section becomes `EmptyState` (heading focused) with the `InlineToast` receipt
above. Off switch: Settings › Input, printed keys vanish when off. Location:
span `max(1.6, 6×accuracy)`, ring at true scale (none below 14px), `note`
inside the card, `maxWidth` 420. One closing row per answer: chips live,
`FeedbackRow` later.

# The sixth drop — 2026-09-19: two amendments

- **D3's evidence rail never collapses.** "Each block is independent — a
  block whose data does not exist is simply absent, and the rail itself never
  collapses: a pane count that changes as you click through files is worse
  than a rail with one block in it." Stale is built from `mtime`; Untrusted
  is drawn disabled with "needs provenance".
- **D6 gains a `Colour` control**: `Label "Colour"` + `FilterRow` topic ·
  distance · folder · entity, and the caption reads "the caption names the
  ACTIVE colouring rule, not a constant". The controls' footer prints, in
  gold, "stale needs mtime · untrusted needs provenance".

The keyboard question in "What this settles" above was answered by the
fourth drop (D36: focus-scoped, with the off switch); the paragraph is kept
as written for the record.
