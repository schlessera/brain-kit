Brain Kit is the interface of brain-kit: a file-first second brain that a coding agent operates. Every screen is a conversation with that agent, so the system is built to answer three questions at a glance: **who is acting, what it will change, and whether you can trust it.** Dark is the home theme; Paper is its light counterpart; Print is the palette a shared PNG or PDF is drawn in.

In real code, import components from `@schlessera/brain-ui-kit` and load `@schlessera/brain-ui-kit/styles.css` once (a consumer with its own Tailwind theme imports `tokens.css` instead). In a mockup, mount `window.BrainKit.<Component>`, or render a Storybook story with `BrainKit.__mount(el, "<Story title>", ["<Story>"])`. Never restate a token's value: reference `var(--bk-…)`.

## Content

- **Write from the user's side.** Name what people recognise: "Approve the raft manifest", not "commit write_policy". Active voice; a control says exactly what happens.
- **Mono is machine fact, Jakarta is human.** Paths, states, effects, spend, hashes, timestamps and counts are set in `mono`/`meta`. Anything a person or the model wrote is set in the body face.
- **Every effect is named.** A control that writes carries its effect chip (`enqueue`, `snooze`, `write_policy`), and the chip is part of its accessible name: "Approve this edit, enqueue".
- **Status words, not colour alone.** Tags such as `SENT · WAITING FOR THE HOST` or `NOT SENT YET · SAVED ON THIS DEVICE` are uppercase mono with ` · ` separators; a monochrome screenshot must still parse.
- **Honest numbers.** An unknown cost never reads as `$0`. Don't promise timings in copy except where the system really keeps one ("checking again in 5 s").
- **Errors say what happened and what to do**, without apology: "This device couldn't save your answer, so it can't send it later. Stay online and try again."
- **Example content is the Odysseus world**, dated around 2026-07-12: the voyage, the crew, Circe, the Sirens, Scylla and Charybdis, Ithaca. Never real people, companies or hosts. No emoji.

## Colour

Colour carries one meaning per hue, everywhere. Use the tone names, never a hex.

| Tone | Means | Use |
| --- | --- | --- |
| `amber` | the agent | work in flight, a permission it asks for, the one primary action per screen |
| `teal` | your turn | your choices, safe outcomes, resolutions that cost nothing, files and people |
| `purple` | provenance | untrusted origin and subagent work: a persistent label on the item, never a phrase in prose |
| `gold` | caution | staleness, an unverified premise, retries |
| `red` | failure | dead letters, quarantine, destructive paths, overdue |
| `blue` | companies | entity tone for organisations, T1 triage |
| `neutral` | machine meta | the grey accent, and only that |

- **Grounds step up:** `bk-color-canvas` → `bk-color-surface` (cards, sheets) → `bk-color-raised` (hover, wells, insets). Hairlines are `bk-color-line` when inert and `bk-color-edge` on things you can tap.
- **Ink comes from the ramp, never from alpha:** `bk-color-ink` (primary), `bk-color-ink-dim` (secondary), `bk-color-ink-mute` (machine meta, the floor). Never fade a row with `opacity`; hierarchy is weight and size.
- **Each accent has three roles on Paper:** `*-ink` for text, icons and borders; `*-fill` for solid surfaces; `*-mark` for 6–8px dots. In Dark all three are the same colour. Fill-as-text is illegible on Paper, and ink-as-fill turns a button to mud.
- **Text on any solid fill is `bk-on-fill`** (near-black, weight 500+), including count badges. Never white.
- **Tints are 4–10% alpha, borders 30–50%,** and each component has its own point in that band (`bk-chip-*`, `bk-surface-*`, `bk-callout-*`). Use the component, not the ramp value.
- **Entity tone vs fact tone:** a ContactCard's avatar tone says what kind of thing it is (teal person, blue company, purple project); its fact rows say what state it is in, with the full set including `gold` and `red`.
- Paper is not Dark inverted: hue carries the meaning, lightness carries the contrast. Every accent was darkened until it passes on its own tinted ground.

## Type

Three families, one job each:
- `display` (DM Serif Text) is for titles only, 17–29px (`title-sm` … `title-2xl`). Nothing in serif that isn't a title.
- `body` (Plus Jakarta Sans) is for everything a person wrote: `prose` for answers, `body`, `row-title` for row and card titles, `label` for controls, `body-sm` and `caption`.
- `mono` (JetBrains Mono) is for machine facts: `mono`, `meta`, `section-label` (uppercase, 0.09em, `bk-color-ink-mute`) and `mono-xs`.
- Nothing renders below 9px. The fonts are served by Google Fonts; load all three families.

## Space, radius, borders

- **Spacing is not a 4px grid,** on purpose: 2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 26. Gaps are 7–9 inside cards, 10–12 between cards and 14–18 between groups. Pick from the set; never round to the nearest four.
- **Radius tracks size:** `radius-chip` 5 · `radius-inset` 8 · `radius-option` 11–12 · `radius-card` 13–14 · `radius-panel` 16–18 · `radius-sheet` 26 · `radius-device` 42 · `radius-pill`. Both ends of a range ship.
- **Border weight is information:** a hairline is inert, a strong border is tappable, a bold border blocks a queue item, and a dashed border is a premise that may have rotted.
- Depth is the ground ramp, not shadow. Only floating layers cast one: the CommandPalette (`bk-palette-shadow`) and the composer's voice glow.

## States and interaction

- **Hover** lifts the same surface one step (`bk-color-raised`) and never changes the tone: a control that looks like something else on hover has lied about what it does.
- **Pressed** is `translateY(1px)` with a slight brightness drop and no colour change.
- **Focus** is a 2px `bk-color-ink` outline, offset +2 on controls and −2 on full-width rows, via `:focus-visible`. Ink, not an accent, because focus says where you are.
- **Disabled** is opacity .45, inert and `aria-disabled`, paired with a mono line saying why.
- **Interactive treatment appears only when a handler is passed.** A row with no `onClick` is not focusable and gets no hover.
- **One ambient animation:** `breathe` (2s on status dots, 3s on the agent core). Nothing else moves on its own, and reduced motion makes it a still dot.

## Accessibility (non-negotiable)

- Never colour alone: every state pairs colour with a word or an icon.
- Touch targets reach 44px, but small visuals stay small: extend the target past the paint and state the reach. Hairlines on hit-expanding elements are inset shadows, not borders. Desktop pointer-only rows may drop to 32px.
- `StreamingAnswer`'s phase line and `InlineToast` are polite live regions; background escalations announce once.
- Text holds 4.5:1 on its ground in Dark, Paper and Print. Storybook runs axe at `error` in both Dark and Paper; four measured contrast exceptions are recorded in `docs/decisions/design-feedback.md`.
- Design at 320px first. Every block component also has a wide layout.

## Loading, empty and error

`Placeholder` owns all three at card level, `EmptyState` at screen level. Loading is skeleton bars on `breathe`, never a spinner. Empty is a dashed hairline plus a mono sentence saying what would be here and why it isn't. Error is a red hairline, the failure named, and a retry where one exists.

## Iconography

Components never name an icon from a set. They pass a semantic key (`approval`, `choose`, `failed`, `capability`, `scope`, `thread`…), which `Icon` maps to a Lucide glyph (`lucide-react`). To add an icon, add a key to `ICONS`; to change sets, change that one map. Icons inherit `currentColor`. There is no logo: set the wordmark `brain-kit` in the display face.

## Components

Pick by job, then read the component's card:
- **Primitives:** Button, Chip, Label, Callout, Surface, StatusDot, Meter, Toggle, PathRef, DiffBlock, Icon.
- **Rows:** ListRow, FileRow, FilterRow, ChoiceOption, QueueItemRow.
- **Evidence:** Receipt, SearchResultCard, TraceSteps, BarList, DataTable.
- **Decisions:** AskUserCard, AskUserGroupCard, AskUserListCard, AskUserRankCard, AskUserFormCard, ApprovalCard, ActionCard, DispositionBar, EffectPreview, NotificationCard.
- **Blocks:** CodeBlock, ContactCard, Disclosure, QuoteCard, StatTiles, StepList, TrendChart, TimelineList, ScheduleList, MapView, PlaceMap, TrackMap, LinkPreviewCard, FeedbackRow, TrackerPillList.
- **Conversation:** MessageBubble, StreamingAnswer, SuggestionChips, TurnErrorCard, InlineToast, EmptyState, AttachmentRow, ComparisonTable, DigestCard, RelatedFiles.
- **Chrome:** Composer, ScreenHeader, ScreenBody, TabBar, BottomSheet, DiscButton, ModelPicker; desktop: SideRail, CommandPalette.
- **Agents:** AgentOrbit, AgentRunCard, LaneChart, GraphView.

Components are prop-driven: props in, callbacks out, with no stores, fetches or globals. A new surface should be assembly work; if it needs a new component, that is design work, and it goes on an issue labelled `needs: design`. The Screens and Rules cards show assembled screens and the kit's own rule stories.

## Not synced

- `PlaceList`, `PlaceMap`, `ScaleList` and `AskUserListCard` have no live preview: their stories depend on the full chat app. `ScaleList` is shown inside `AskUserFormCard`.
- Story play functions (interaction tests) are not run here. Previews mount each story's args and decorators only.
- Fonts are hosted by Google Fonts, not shipped as files.
