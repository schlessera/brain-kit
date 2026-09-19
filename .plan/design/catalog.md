# Brain Kit catalog — foundations, sections, assembled screens

> **2026-09-18 drop.** The catalog now lives at `kit/Brain Kit.dc.html` (it
> was at the project root), and two sibling catalogs joined it:
> `kit/Brain Kit Light.dc.html` (→ `light.md`) and `kit/Brain Kit Desktop.dc.html`
> (→ `desktop.md`). Sections that changed in this drop are marked below; the
> unmarked ones are unchanged from the 2026-08-26 drop this digest was written
> against.

Source: `kit/Brain Kit.dc.html` from the design drop (829 lines, one `<x-dc>`
template plus one `DCLogic` class). Values below are reproduced exactly from
that file, not paraphrased from the README.

---

## 1. Foundations (§01)

### 1.1 Colour — the full token set

From the catalog's `PALETTE` array, in order. Column three is the file's own
stated use, verbatim.

| Token | Hex | Use |
|---|---|---|
| canvas | `#0c0e12` | app background, device screen |
| surface | `#141619` | cards, sheets, tab bar |
| raised | `#1a1d22` | user bubbles, pills, notifications |
| line / edge | `#1f2229` | hairline inside cards · `#2a2d35` borders |
| ink | `#e8e4df` | primary text |
| ink dim / muted | `#c0bcb5` | secondary · `#9a96a1` machine meta (was `#8a8691` until the fourth drop) |
| amber | `#e09f3e` | agent acting, approval, primary action |
| gold | `#eab354` | caution, staleness, unverified premise |
| teal | `#5bb5a2` | your turn, ok, files & people |
| purple | `#b197d4` | untrusted origin, subagents, projects |
| blue | `#67b8e3` | companies, T1 triage |
| red | `#f87171` | failure, danger, dead letter |

Two tokens are named inside a row rather than getting one of their own, and both
are load-bearing: **`#2a2d35`** (the border/edge colour, distinct from the
`#1f2229` internal hairline) and **`#9a96a1`** (machine meta — the README now calls
it "the floor, 4.80:1 on the worst tint"; it was `#8a8691` at 5.10 on surface
until the fourth drop restated it against the worst ground).

Rules the file states about colour:

- "Two background colours, four inks, seven meanings. **Tints are the accent at
  4–10% alpha; borders at 30–50%.**" Observed in the markup: `rgba(224,159,62,.05)`
  fills, `rgba(224,159,62,.4)` borders, `rgba(177,151,212,.4)` provenance chip
  borders, `rgba(248,113,113,.35)` policy borders.
- **Ink never comes from alpha.** Hierarchy is weight and size; only
  `#e8e4df` / `#c0bcb5` / `#9a96a1` are used, because alpha-muted ink drops 9–12px
  type under 4.5:1.

Note the catalog *page chrome* uses `#0f0f11` for its own background (set in the
helmet `<style>`), which is **not** an app token — the app canvas is `#0c0e12`.
Do not carry `#0f0f11` into `ui-kit`.

### 1.1b The tone vocabulary (new in the 2026-09-18 drop)

§01 gained a `TONE_VOCAB` table — ten members, "each meaning exactly one thing
in every component" — after the port found `neutral` resolving to four
different values across four components (design-feedback §4). Verbatim:

| Tone | Dark | Means |
|---|---|---|
| `amber` | `#e09f3e` | agent acting · approval · primary action |
| `gold` | `#eab354` | caution · staleness · load · retries |
| `teal` | `#5bb5a2` | your turn · ok · files & people |
| `purple` | `#b197d4` | untrusted origin · subagents · projects |
| `blue` | `#67b8e3` | companies · T1 triage |
| `red` | `#f87171` | failure · danger · overdue obligation |
| `ink` | `#e8e4df` | primary text — **not** `neutral` |
| `dim` | `#c0bcb5` | secondary text · unlisted-tone fallback |
| `neutral` | `#9a96a1` | the grey **accent**: machine meta |
| `edge` | `#2a2d35` | hairlines and rails — **not** `neutral` |

"`neutral` is the grey accent and nothing else. A component that wants default
text, a dim label or a hairline names `ink`, `dim` or `edge`. **Every tone
lookup falls back** (`this.C[x] || this.C.dim`) rather than inheriting, so an
unlisted name renders as something rather than as nothing. The dead `muted`
entries in `Receipt` and `ComparisonTable` are gone — `dim` is the real
member." And for `ContactCard`: "Entity tone vs fact tone … facts take the full
set including `gold` and `red`. A relationship twenty years cold is `red`, not
amber." Ported as D33.

Text on a solid accent fill is **near-black ink** — `#0c0e12` dark / `#231f1a`
light, the README's `--on-fill` — "including count badges, which are the one
place the kit had used white (2.77:1 on red; near-black is 6.75:1)". That is
design-feedback §6, resolved.

### 1.2 Type — three families, one job each

| Family | Sizes | Job |
|---|---|---|
| **DM Serif Text** (fallback Georgia, serif) | 17 / 19 / 22 / 24 / 26 / 29 | screen + sheet titles **only** |
| **Plus Jakarta Sans** | 10.5 – 15 | 400 body / 500 label / 600 emphasis |
| **JetBrains Mono** | 9 – 12 | paths, states, effects, money |

One further named specimen: the **section label** — `9.5px / 600 / .09em`
letter-spacing, uppercase, mono, colour `#9a96a1`. That is the `Label`
component's default and it recurs on every screen.

Stated rule: "Nothing below 9px, and nothing in serif that isn't a title."

The catalog's own chrome uses two sizes outside the app scale (a 42px serif
page title, a 10px/.14em mono section number). Those are catalog furniture, not
tokens.

Font loading: `<helmet>` pulls one Google Fonts stylesheet —
`DM+Serif+Text:ital@0;1`, `Plus+Jakarta+Sans:wght@400;500;600;700`,
`JetBrains+Mono:wght@400;500;600`, with `display=swap` and both `preconnect`
links. Note Jakarta ships weight **700** even though the type scale tops out at
600.

### 1.3 Radius

Swatches drawn: **5 · 8 · 12 · 14 · 18 · 999**. The scale as the file labels it:

```
5 chip · 8 inset · 11-12 option · 13-14 card · 16-18 panel · 26 sheet · 42 device · 999 pill
```

"Radius encodes scale: the smaller the thing, the tighter the corner."

### 1.4 Space

```
space 2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 26
gap 7-9 inside cards · 10-12 between cards · 14-18 between groups
```

There is no 4px-multiple grid — the scale is deliberately irregular and the gap
rule is stated as ranges, not values. (This is the spacing scale the repo does
not currently have.)

### 1.5 Motion — one keyframe, defined once per file

```css
@keyframes breathe {
  0%,100% { box-shadow: 0 0 0 0 rgba(224,159,62,.15); opacity: 1 }
  50%     { box-shadow: 0 0 8px 2px rgba(224,159,62,.15); opacity: .6 }
}
```

Applied as `animation: breathe 2s ease-in-out infinite`; **3s** on the brain
core in `AgentOrbit`. "The only ambient motion. Nothing else moves on its own."

**This is the only shared CSS in the kit, and it is not actually shared** — it
is redeclared inside the `<helmet><style>` of 13 separate component files
(`ActionCard`, `AgentOrbit`, `AgentRunCard`, `InlineToast`, `PhoneFrame`,
`Placeholder`, `QueueItemRow`, `ScreenHeader`, `StatusDot`, `StepList`,
`StreamingAnswer`, `TraceSteps`, and the catalog itself). It is **not** deduped:
the helmet manager content-dedupes `<script>`, `<link>` and `<meta>` only —
`<style>` elements go down a separate path keyed by *component name*, so thirteen
identical `@keyframes breathe` blocks really do end up in `<head>`. Harmless in
CSS, but it means the kit has no shared stylesheet at all. In `ui-kit` it becomes
one global rule.

Every one of the 56 components also carries `body{margin:0;background:#0c0e12}`
in its helmet, so **rendering any single kit component repaints the whole page
background**. That is a global side effect a Storybook story will inherit; the
port should move it to one preview-level style and drop it from the components.

Two further keyframes exist in `Second Brain Mobile.dc.html` but **not** in the
kit: `filament-scan` (the chat header's scanning rule) and `orbit`
(`to { transform: rotate(360deg) }`). The kit's `ScreenHeader filament` and
`AgentOrbit` re-implement those statically — orbit pills are "placed, not
animated".

Other global CSS in the catalog helmet: `body{margin:0;background:#0f0f11;
font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:#e8e4df}` and
`a{color:#e09f3e}a:hover{color:#eab354}`. The `a:hover` rule is the **only
hover state anywhere in the kit**.

### 1.6 Icons — semantic keys, one mapping file

Components never name a glyph. They pass a semantic key; `Icon.dc.html` holds
the only mapping, **77 keys** → Lucide 0.454.0 names. The catalog displays 36 of
them with a tone map (`ITONE`) that assigns: amber to `approval`, `capability`,
`brain`, `suggestion`, `deadline`; teal to `choose`, `resolved`, `file`; red to
`failed`, `quarantined`, `policy`; gold to `unverified`; purple to `trust`; grey
`#9a96a1` to everything else.

To swap sets: repoint the values in `SET` and replace the single
`<i data-lucide>` line. Nothing else in the kit names an icon.

---

## 1b. §11 accessibility notes that changed (2026-09-18 drop)

`A11Y_NOTES` gained two entries and rewrote a third. Verbatim:

- **Specify reach, not box size.** "A 44px target is not a 44px box. Small
  visuals stay small and extend their target past the paint — a transparent
  `::before` at negative inset, or padding cancelled by equal negative margin.
  Always specify the REACH past the paint, never a finished box size: box size
  is a derived number that depends on a border the spec may not mention."
- **Hairlines on expanding targets are inset shadows.** "An absolutely
  positioned pseudo-element is offset from its containing block's PADDING box,
  so a 1px border silently eats 1px of reach per side — 2px per axis. Draw the
  hairline with `box-shadow: inset 0 0 0 1px` instead, and an underline with
  `text-decoration` rather than `border-bottom`. Neither touches the box model,
  so the stated reach is the real reach. Toggle only ever measured correctly
  because it happens to have no border."
- **Expansion is constrained per axis.** "Expansion per side must be ≤ half the
  distance to the nearest interactive neighbour ON THAT AXIS — a row of
  side-by-side targets constrains only the horizontal. FeedbackRow reaches its
  full 9px vertically (44px tall from a 26px visual) but 8px horizontally
  against an 18px gap, leaving 2px spare … verify with `elementFromPoint` at
  each target's edges, never its centre. Desktop pointer-only rows may go to
  32px."

The README adds the measured set: Toggle 38×22 → 44×44; FeedbackRow thumbs
30×26 → **46×44** (`inset:-9px -8px`); InlineToast undo 25×13.65 →
**45×45.65** (`inset:-16px -10px`); TabBar items ~33px → 51px via negative
margin. This is the design's answer to design-feedback §1 (D34).

The role-and-keys table is unchanged: no `Home`/`End` (design-feedback §11
stays open), and `a / d / s`, `1–5`, `←→ to fold` are still listed with nothing
said about scope (§10 stays open — see `desktop.md` for the new evidence).

## 2. Section structure

Eleven numbered sections. Section number · title · what it demonstrates ·
components appearing in it.

| § | Title | Demonstrates | Components |
|---|---|---|---|
| **01** | Foundations | colour ramp, type specimens, radius/space/motion, the semantic icon grid | `Icon` (36 instances) |
| **02** | Primitives | "Ten files carry all the styling… there is no second place to define a border or a label size" | `StatusDot`, `Chip` (9 variants × 7 tones), `Label`, `Meter`, `Button` (6 tones), `Toggle`, `PathRef`, `Surface` (5 emphases), `Callout`, `DiffBlock` |
| **03** | Evidence & data | "the things the user is asked to trust… every number carries its unit" | `Receipt`, `TraceSteps` (rail + list), `DataTable`, `BarList`, `SearchResultCard` |
| **04** | Rows & lists | four row types that differ by *what the row is*, not which screen shows it | `ListRow` (4 variants), `ChoiceOption`, `FilterRow`, `Chip` (pill), `FileRow` (4 kinds), `QueueItemRow` (6 states), `Surface` |
| **05** | Decision surfaces | "where the async loop meets the user"; `ActionCard.kind` sets icon, colour, border weight and kind label together | `ActionCard` (7 kinds — approval, choose, dead-letter, quarantined, unverified, fyi, suggestion), `AskUserCard`, `ApprovalCard`, `NotificationCard` (rich/compact/dim) |
| **06** | Agent & corpus views | two metaphors for "is real work happening?" | `AgentOrbit`, `LaneChart`, `AgentRunCard` (running/waiting/failed), `GraphView` |
| **07** | Chrome | "a screen is assembled by nesting, not by copying markup" | `ScreenHeader` (title/nav/hero, + filament), `MessageBubble`, `Composer` (send/voice/plain), `TabBar`, `BottomSheet`, `Chip`, `Callout`, `Button` |
| **08** | In-chat content blocks | the shapes an answer can take instead of prose | `StepList` (numbered/checklist/progress), `MapView`, `TimelineList`, `ScheduleList`, `QuoteCard`, `CodeBlock`, `LinkPreviewCard`, `StatTiles`, `TrendChart`, `ContactCard`, `Disclosure`, `FeedbackRow`, `TraceSteps` |
| **09** | Loading, empty & error | `Placeholder` owns all three so they cannot diverge; four components swap to it at their own size with their own copy | `Placeholder` (loading/empty/error), `ActionCard` (`state`), `QueueItemRow` (`view`), `SearchResultCard` (`view`), `FileRow` (`view`) |
| **10** | Conversation lifecycle | what came in, what shows while the answer arrives, what is offered once it lands, the receipt for what it did | `StreamingAnswer`, `SuggestionChips`, `AttachmentRow` (image/audio/doc/link), `InlineToast`, `ComparisonTable`, `RelatedFiles`, `DigestCard`, `EmptyState` (5 variants) |
| **11** | Assembled — screens the mockups never had | "a novel surface should be assembly work, not design work" | see below |

Not exercised anywhere in the catalog but present as files: **none** — all 56
`*.dc.html` components appear at least once. `Placeholder` appears both directly
(§09) and as the internal state of four other components.

---

## 3. §11 — the assembled screens

**There are four, not two.** The section header says "screens the mockups never
had" and the intro says: *"All four screens below are pure composition: no new
colours, no new type sizes, no bespoke markup beyond layout. This is the test the
kit has to pass."*

These four are the acceptance test for the component set. Composition is given
in exact nesting order, with the props that select a variant.

### 11.1 Morning digest

> 2026-09-18 drop: `digestStats` is **three tiles** now (filed / waiting /
> failed; was four) — the design's answer to design-feedback §14's 3 + 1 wrap —
> and `digestToday` has two items, so the `Label meta="2 items"` agrees with
> its group. The `Label "Today"` above a `ScheduleList` group headed "Thursday
> 27 Aug" still renders two headings one line apart; the design kept both, so
> that composition stands as designed (section label + date heading), and only
> the count mismatch was a defect.

> "The destination behind 'What's new?' — with the overnight work stated as fact
> before anything asks for a decision."

```
PhoneFrame
├── ScreenHeader  variant="title" title="This morning" meta="06:40" trailingIcon="digest"
├── <div>  flex column, gap 11, padding 4px 16px 8px
│   ├── StatTiles     tiles={digestStats} minTile=96
│   ├── Label         text="Overnight" icon="activity" meta="$0.40"
│   ├── TimelineList  items={digestOvernight} timeWidth=44
│   ├── Label         text="Today" icon="calendar" meta="2 items"
│   ├── ScheduleList  groups={digestToday} timeWidth=44
│   ├── ActionCard    kind="fyi" footDot="amber" footPulse chevron
│   └── Callout       variant="banner" tone="teal" icon="resolved" mono
└── TabBar        active=2
```

### 11.2 Chat answer, fully structured

> "MessageBubble + Disclosure + StatTiles + QuoteCard + StepList + MapView +
> FeedbackRow — **no prose paragraph anywhere**."

```
PhoneFrame
├── ScreenHeader   variant="title" title="Brain" titleSize=19 avatarIcon="brain"
│                  subtitle="connected · tailscale" subTone="teal" subDot="teal"
│                  trailingIcon="history" filament
├── <div>  flex column, gap 10, padding 14px 16px 6px
│   ├── MessageBubble  role="user" actions={false}
│   ├── Disclosure     label="6 steps · 4 files touched · 2.4s"
│   ├── StatTiles      tiles={chatStats} minTile=96
│   ├── QuoteCard      locator="line 34"
│   ├── StepList       variant="progress" steps={packSteps}
│   ├── MapView        title="LX Factory" height=88
│   └── FeedbackRow    question="Did that answer the question?"
├── Composer
└── TabBar         active=0
```

### 11.3 Weekly review

```
PhoneFrame
├── ScreenHeader  variant="title" title="This week" meta="7 days · 41 runs" trailingIcon="filter"
├── <div>  flex column, gap 11, padding 2px 14px
│   ├── FilterRow   items={weekFilters} active=0
│   ├── Surface     label="Spend · 7 days" labelIcon="wallet" meta="$9.40 / 35"
│   │   └── <div> flex column gap 11
│   │       ├── Meter    variant="bar" value=27 height=7 tone="teal"
│   │       └── BarList  rows={weekSpend}
│   ├── Label       text="What changed" icon="activity"
│   ├── Surface     pad=0
│   │   ├── ListRow  variant="group" icon="resolved" value="94%" valueTone="teal"
│   │   └── ListRow  variant="group" icon="failed" actionLabel="Open" last
│   ├── ActionCard  kind="suggestion" rightMeta="saves ~9 taps/wk"
│   │   └── <div> flex gap 8
│   │       ├── Button  tone="primary" size="md" center effect="write_policy"
│   │       └── Button  tone="quiet"   size="md" center
│   ├── Label       text="Carried into next week" meta="3"
│   ├── <div> spacer  flex:1
│   ├── <div> flex column gap 2
│   │   ├── ListRow  variant="plain" icon="approval"   iconSize=14 value="snoozed 2d"
│   │   ├── ListRow  variant="plain" icon="choose"     iconSize=14 value="snoozed 4d"
│   │   └── ListRow  variant="plain" icon="unverified" iconSize=14 value="premise stale"
│   └── Callout     variant="banner" tone="neutral" icon="digest" mono
└── TabBar        active=2
```

This is the deepest nesting in the kit — `PhoneFrame > Surface > Meter/BarList`
and `PhoneFrame > ActionCard > Button` — and therefore the one to port first
when checking that removing the DC `.sc-host` wrapper div has not broken layout.

### 11.4 Run detail, stalled mid-flight

```
PhoneFrame  showHome
├── ScreenHeader   variant="nav" title="researcher"
│                  subtitle="run #4c1 · turn 12 · ~$0.14" trailingDot="amber"
├── <div>  flex column, gap 9, padding 12px 16px 8px
│   ├── AgentRunCard  tools={runTools}
│   ├── Label         text="Tool timeline" meta="4 steps"
│   ├── TraceSteps    variant="list" steps={listSteps}
│   ├── ApprovalCard  tool="WebFetch" target="lxfactory.com/spaces" toolIcon="search"
│   │                 badge="Outside envelope" diff=… risk=…
│   │                 allowLabel="Fetch once" denyLabel="Skip it" allowEffect="enqueue"
│   ├── Label         text="What this run is holding" icon="thread" meta="2"
│   ├── QueueItemRow  state="blocked" link="waiting on this fetch"
│   ├── QueueItemRow  state="ready"
│   └── Callout       variant="banner" tone="neutral" icon="scope" mono
└── Composer       variant="plain" placeholder="Send a note to this run…"
```

Note: no `TabBar` — this is a pushed detail screen, and the `Composer` is the
`plain` variant (no send affordance, observation only).

### What §11 proves, and what it does not

Passes: 4 novel screens, 20 component types, **zero bespoke markup beyond flex
containers**. Every colour, size and radius comes from a component.

Two caveats the README states and the file confirms:

- **§11 predates §10.** None of the four screens uses `SuggestionChips` or
  `InlineToast`, even though the chat screen obviously wants both.
- The only non-component markup is layout: `<div style="flex:1;min-height:0;
  overflow:hidden;padding:…;display:flex;flex-direction:column;gap:…">` and two
  spacers. That padding/gap pattern (`padding 2–14px 14–16px`, `gap 9–11`) is
  the screen-body container and is the one thing §11 does **not** offer as a
  component. `ui-kit` should have a `ScreenBody` for it or every screen will
  re-type it.

---

## 4. Prose and markdown — the specimen gap

The README's "Known gaps" says prose/markdown rendering is "documented as type
specimens in the catalog rather than a component." **In the catalog file, those
specimens are only the §01 Type panel** — three lines showing DM Serif at 26,
Jakarta body at 13.5 with a 600 emphasis run, and a mono line with a muted tail.
A full-text grep for `prose`, `markdown`, `wiki`, `heading`, `specimen` over
`Brain Kit.dc.html` returns nothing else.

The real prose specimen is in the **mobile screens file, screen 1f (File
viewer)**, as raw markup. Its type values:

| Element | Value |
|---|---|
| document title | `400 22px/1.2 'DM Serif Text', Georgia, serif` |
| body paragraph | `400 13px/1.75 'Plus Jakarta Sans'` — **1.75 line height, the loosest in the system** |
| body emphasis | `600 12.5px/1 'Plus Jakarta Sans'` |
| section heading | `600 11px/1 'Plus Jakarta Sans'` |
| blockquote / aside | `italic 400 12.5px/1.65 'Plus Jakarta Sans'` |
| frontmatter chip | `500 9.5px/1.4 'JetBrains Mono'` (kv chips, one per key) |
| wiki-link | teal `#5bb5a2`, prefixed `↗` |
| backlink path | `500 10.5px/1 'JetBrains Mono'` |
| ink colours in prose | `#e8e4df` body, `#c0bcb5` secondary, `#9a96a1` meta, `#b197d4` tags |

**This is a gap, not a finding.** There is no `Prose` / `Markdown` component in
the kit, `packages/ui-react/src/components/chat/brain-markdown*.tsx` already
solves the same problem with a different vocabulary, and D4 forbids inventing
components the design does not show. The honest reading: the type values above
are a **style contract for the existing markdown renderer**, not a new component
to build.

## §11 as revised by the fourth drop (2026-09-18)

The role-and-keys table now reads: Toggle `switch + name` · ChoiceOption
`↑↓ · home/end · space` · FilterRow/TabBar `←→ · home/end · ⌘1–5` · SideRail
`↑↓ · home/end · ⌘1–5` · ListRow/FileRow `⏎ · ←→ fold · home/end` ·
ActionCard `a / d / s while focused` · CommandPalette `⌘K · ↑↓ · home/end ·
esc`. The Hover row: "untoned surface +1 step (#1a1d22) · a TONED card goes
tint +.04 alpha, not to #1a1d22". Five new rule cards: single keys are
focus-scoped; Home/End everywhere a roving tab stop exists; hover on a toned
card is tint +.04; Toggle carries a name; focus after a decision. The three
bare toggles in §1 gained visible labels ("Ask before writing files",
"Announce resolutions", "Single-key shortcuts" — the last is the Settings off
switch D36 names). See design-feedback "The fourth drop" and D35/D36.

## §13 added by the sixth drop (2026-09-19)

"A question is an exchange · a mask is a receipt." Left: `AskUserCard` in its
three states (pending with the Other field open; answered; typed). Right: the
`request_image_mask` result — a `Surface "Mask drawn"` holding a hatched thumb
with a teal dashed region and a size chip, stacked above a `Receipt` (region ·
covers · source · mask, `keyWidth` 58), then the failure `Callout` (red, boxed,
mono). The §12 chat screen also lost three demo rows (a `QuoteCard`, a
`Callout` banner, a `QueueItemRow`) in the same edit. See design-feedback "The
sixth drop" §1–2 and the new "Where truncation is allowed" rule.
