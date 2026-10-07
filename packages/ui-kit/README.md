# @schlessera/brain-ui-kit

The brain-kit design kit: presentational React components, the design tokens
they are built from, and the Storybook that documents them.

Everything here is **prop-driven**. Props in, callbacks out — no stores, no
`fetch`, no ambient configuration, no browser globals. That is not a style
preference: kit components can render in a story, a test or another embedder
without depending on application state. `@schlessera/brain-ui-react` owns that
state in isolated roots created by `createBrainUiRoot` and selected through
`BrainUiProvider`; hooks outside a provider use the default application root
([UI roots](../ui-react/README.md#ui-roots)). Kit components need neither a root
nor a provider, and `scripts/check-kit-purity.ts` enforces that separation.

## Status

The kit covers primitives, rows, evidence blocks, question and decision cards,
conversation states, agent views, screen chrome and desktop navigation.
Assembled Storybook screens exercise Morning Digest, Chat Answer, Weekly Review,
Run Detail, Actions Triage, File Viewer and First Run. Browser
interaction/accessibility checks and curated visual baselines run in CI.

`@schlessera/brain-ui-react` consumes the kit: its chat, files, settings, graph
and desktop surfaces are assembled from these components. Why the kit is shaped
the way it is — the component API, the tokens, the light theme, the
accessibility gate — is in `docs/decisions/design-kit.md`, and the measured
design divergences several components ship on purpose are in
`docs/decisions/design-feedback.md`.

## Loading

Loading is blurred ghost text in the replaced content's type role, with one
spectrum band per frame and a 600ms cross-fade when that item's data arrives.
Glyphs stay static; only the band's transforms move. The band spans the text block; broad edge fades scale with the frame, so the
text lights up gradually across its width. Frames,
icons and status-dot slots keep their final geometry. Loading states are not
ambient motion: they end when the data does. Reduced motion shows plain blurred
base text and makes the handoff instant; print hides ghosts.

Queue and search `index` props remain accepted, but no longer stagger the
sweep. The owning frame shares one sweep across all of its text slots. See
D53 in `docs/decisions/design-kit.md` and the `States/GhostSweep` Storybook
review gallery.

## Grouped questions

`AskUserGroupCard` presents two to four questions as one exchange, with one
header and action row. The caller supplies each section's options, current
answer, controlled Other text and callbacks. The kit marks unanswered sections
and moves focus when **Go to unanswered** is activated; **Submit** returns all
answers together. Answered and dismissed exchanges keep one row per question.
Use `AskUserCard` for a single question, including its composer-typed state.

## Ranked questions

`AskUserRankCard` orders two to fifteen stable item ids in one exchange. The
caller supplies the question, labels and optional details, links and cutoff;
Submit returns every id in order and whether the original order was kept.
Users can drag a handle, tap an item then its destination, or use the keyboard.
Handle gestures capture the pointer while the rest of the row scrolls the
transcript. Answered cards retain the order; dismissed cards can be asked again.

## Conditional questions

`AskUserFormCard` presents `single`, `multi`, `scale`, `rank` and short `text`
nodes in one exchange. The caller supplies `question` and a flat `nodes` list;
`showIf: { node, anyOf }` reveals a child when an earlier choice matches. Children
occupy branch slots below the parent's whole control, without accumulating
indentation. Breadcrumbs identify the path and shorten beyond three levels.
The form has one sticky header and one outer action row.

Changing a choice sets hidden branch answers aside locally, with an Undo
receipt; revisiting the branch restores them. `onSubmit` receives
`{ answers, visibleNodes }` and omits hidden answers. Nodes default to required;
an incomplete submission flags missing required answers and focuses the first
flagged node. Revealing a branch announces the change and keeps focus on the
current control.

Use `state="answered"` with `answers` to replay a compact summary of the visible
paths, skipped optional questions, scale groups and ranked items. Longer
records can expand. `state="dismissed"` accepts `lapsedNote` and `onAskAgain`,
as the standalone cards do.

`ScaleList` and `RankList` export the same controls used by the standalone
`AskUserListCard` and `AskUserRankCard`. Their `embedded` prop defaults to
`true`, omitting another header and action row. Both expose `onChange`;
`ScaleList` also exposes `flagged` and `onComplete`, while `RankList` exposes
`onMoveChange` so an outer form can guard submission during a move.

## Attachments

`AttachmentRow` requires `kind` and `label`. Pass duration, metadata, extracts
and provenance explicitly; absent fields draw nothing. `meta` accepts one
string or several lines, and names and metadata wrap. An audio waveform needs
an explicit finite `seconds` value. Sample values belong in stories.

For a static sent-file record, pass `actionIcon=""` and omit `onClick`.
The row then has no role or tab stop. The chat consumer uses this form for
validated tracks; its image thumbnails and zoom controls remain separate.

## Imported tracks

`TrackMap` draws file-provided lines with start/end shapes, a scale and a full
summary and waypoint list. Supply one path per usable section, the complete
track envelope through `fitPoints`, canonical metrics and evidence, and an
original file name/path. Optional background paths/land carry their attribution.
Without background geometry it labels the drawing **Track only**. A
`projectionReason` replaces the drawing while retaining all text and the original.
The component performs no parsing, measurements or requests. `ui-react` resolves
staged originals and optional geography before both chat display and static export.

## Link policy

`@schlessera/brain-ui-kit/links` exports `classifyLink`, the one decision about
what an address a model chose may do: absolute `http(s)` only, no credentials,
no invisible or bidi characters, and no hostname label that mixes scripts
(UTS #39 Highly Restrictive). It is pure and imports no React, so a server can
use it: `@schlessera/brain-ui-sdk`'s `show_block` handler rejects a refused
link with it. `LinkPreviewCard` calls it on its own `url` prop, so the host a
card shows and the address it opens always come from the same parse. The
reasoning is D48 in `docs/decisions/design-kit.md`.

## Styles

Two forms, both generated from `src/styles.css`:

```ts
// A consumer with its own Tailwind v4 build:
//   @import "@schlessera/brain-ui-kit/theme.css";
//   @source "../node_modules/@schlessera/brain-ui-kit/src";

// A consumer without one:
import "@schlessera/brain-ui-kit/styles.css";
```

`src/tokens.css` is the token set, reproduced from the design catalog's
Foundations section; `src/theme.css` imports it and adds the kit's own Tailwind
scales as `@theme static`. A consumer with its OWN Tailwind theme imports
`@schlessera/brain-ui-kit/tokens.css` instead of `theme.css`, or the kit's
`--spacing-2: 2px` silently redefines that consumer's `p-2` (this is what
`ui-react` does). Two things in it are easy to get wrong and are asserted by
`tests/theme-tokens.test.ts`: the spacing scale is deliberately irregular (it is
not a 4px grid), and three radius steps are ranges whose ends both ship.

`tokens.css` also delivers the shared scale, rank and conditional-form layout
and interaction rules. All three stylesheet entries include these rules;
components need no separate form stylesheet.

### Themes

Every colour token is one declaration, `--bk-x: light-dark(<paper>, <dark>)`,
and `color-scheme` picks the half. The stylesheet sets `color-scheme: dark` on
`:root`, so a consumer who does nothing gets the dark kit. To switch, put
`data-theme` on `<html>` — or on any element, for one subtree:

```html
<html data-theme="system">  <!-- follows prefers-color-scheme, no script -->
<html data-theme="light">   <!-- the paper theme -->
<html data-theme="dark">
```

No theme context, no provider, no component knows which theme it is in. A
persisted user choice should be written to the attribute by an inline script
before first paint. `light-dark()` is Baseline since May 2024; in an older
browser the tokens are invalid at computed-value time and the page renders
without colour — the same loud failure as a missing stylesheet, on purpose.

The light values come from the design's paper contract plus one derivation
rule per token family, generated by `tools/theme/derive-light.ts` and pinned
by `tests/light-theme.test.ts`; edit the generator, not the values. Every
story runs on paper under the same a11y gate as on dark.

## Storybook

Run from this directory:

```sh
bun run storybook          # dev server on :6006, MCP endpoint at /mcp
bun run build-storybook    # static build
bun run test-storybook:ci  # every story's render + play function, in Chromium, dark
bunx vitest run --project=storybook-light   # the same, on paper
```

The story tests run under Vitest browser mode against real Chromium, which is a
separate runner from the repo's `bun test`. Both are expected to pass; they do
not interfere.

Stories are [CSF Next](https://storybook.js.org/docs/api/csf/csf-next)
(`preview.meta` / `meta.story`), the format that becomes Storybook's default in
11. They import the preview through the `#*` subpath map in `package.json`, so
no story carries a `../../.storybook/preview` path.

## Accessibility

`parameters.a11y.test` is `'error'`: axe violations fail the browser suite in
CI. The gate was verified with a seeded violation. Known palette contrast gaps
have explicit, story-scoped exceptions recorded in `docs/decisions/design-feedback.md`;
a green suite does not mean those design issues are resolved. Keyboard groups
use roving tab stops, and reduced-motion behavior is checked in the browser.

The following interaction rules are also covered by stories.

**Interaction states are gated on a handler.** A component that was given no
`onClick` gets no role, no tab stop, no focus ring and no hover — so a static
row never pretends to be pressable. That is an API contract, not styling.

`Button` reads its default rest paint and per-tone hover palette through the
kit stylesheet. Its `style` prop is still merged last onto the root: caller
background, border and colour overrides remain effective during hover as well
as at rest. Other paint channels retain their tone's hover treatment. A caller
using `border: "none"` keeps a border-free target, including the rank footer's
small controls and separate inset hover hairline.

**Roving groups take the arrows, `Home` and `End`.** `FilterRow`, `TabBar`,
`SideRail`, `CommandPalette`, a `ChoiceOption` radiogroup and a stack of
`FileRow`s are one tab stop each; the arrows move inside, `Home` / `End` reach
the edges. A `SideRail` given `acts` adds a second group, a vertical `Acts`
toolbar with its own stop, and `onOpenPalette` adds the `All commands` button
as a third; the arrows never cross from one group into another. Single-letter shortcuts (`a` / `d` / `s`, `j` / `k`) are the app's
and are focus-scoped there; the kit only prints them on the controls.

**Hit targets are not visual size.** Small controls stay small and extend their
target with a transparent pseudo-element: `Toggle` (38x22 drawn), `FeedbackRow`
(30x26) and `InlineToast`'s undo (text-sized). The constraint that makes it safe
is that expansion per side must be no more than half the distance to the nearest
interactive neighbour on that axis — get it wrong and a neighbour's invisible
target steals the click, which is how `FeedbackRow` once recorded thumbs-down
for a thumbs-up.
Each one is asserted with `elementFromPoint` at the target's EDGES in its own
story. **Note the measurement:** `inset` on an absolutely positioned
pseudo-element resolves against the containing block's PADDING box, so a border
reduces the reach. Historically, borders left `FeedbackRow` at 46x42 and the
undo at 43.65px tall, both below the 44px floor. D34 corrected this:
`FeedbackRow` uses an inset box-shadow for its hairline and reaches **46x44**;
the undo uses `text-decoration` for its underline and extends 16px above and
below the text, clearing **44px**. Their `HitTargets` and `UndoHitTarget` stories
assert the reach and zero border widths, preserving the correction alongside
the history in `docs/decisions/design-feedback.md`.

`SideRail` destinations, acts and the `All commands` button keep their 36px
mouse density. When any available pointer is coarse, their rectangular targets
are at least 44×44, including the corners of the rounded paint. The collapsed
60px rail accounts for its 1px border in its insets. The rail's middle (the
destinations through the acts) scrolls within short rails while the wordmark
and `All commands` stay pinned; targets retain the 3px separation. Dedicated
Chromium cases cover fine-only, coarse-only and mixed pointers in both themes.

`DiscButton` paints a 32px disc inside a 44px button. The default `end`
anchor reaches 12px left and 6px up and down, and not right, so the box never
covers a scrollbar; `center` reaches 6px on every side. A labelled disc opens
leftward into a pill on hover and keyboard focus, and its `DiscRow` grows with
it, so a neighbouring disc is pushed rather than covered. Interactive
`SuggestionChips` are at least 44px tall when any available pointer is coarse.
A disabled chip prints its `why` and keeps its `cost`. Dedicated Chromium cases
cover fine-only, coarse-only and mixed pointers in both themes.

`TabBar` uses the design's other sanctioned method — padding cancelled by an
equal negative margin — and that one is exact: padding is not measured against
anything, so a border costs it nothing. The neighbour constraint still applies
and here it has a number. With `justify-content: space-around` the clear gap
between two slots is the bar's free space divided by the slot count, so for the
five default slots it reaches the required 28px at a bar width of **276px**.
Below that a five-slot tab bar steals its own clicks, and
`NarrowBarStealsTheClick` reproduces it at 240px.

**Container-requiring roles get their container.** A `tab` needs a `tablist`, an
`option` needs a `listbox`, a `radio` needs a `radiogroup`. Where the container
element belongs to the component it is rendered — `FilterRow`, `TabBar` and
`SideRail` render their own `tablist`, `AskUserCard` its `radiogroup`,
`CommandPalette` its `listbox` and one `group` per result kind. Where it belongs
to the caller (`FileRow`'s `tree`) the stories show the wrapper it is owed.

**A control that writes says so in its accessible name.** `CommandPalette` puts
the effect chip into the row's `aria-label` — *"Re-index knowledge/, reindex"* —
so the warning is not shown only to people who can see it.

**Live feedback uses polite announcements.** `StreamingAnswer`'s phase line and
`InlineToast` carry `aria-live="polite"`, because both change without
the user doing anything to make them change and are otherwise silent to a screen
reader. `polite` rather than `assertive` in both cases: neither should cut
across whatever is being read.

Pass `announce={false}` to `InlineToast` when a containing live region combines
the receipt with other feedback. `AskUserFormCard` uses this for one announcement
of branch reveals, hidden nodes, answers set aside and the remaining count.

## Dictating composer state

`Composer` accepts `state="dictating"` to preserve a read-only draft and
make Send and Attach unavailable while capture is active. Its mic is labelled
“Stop dictation” and still calls `onMic`; the consumer owns capture, draining
and review. Other composer states keep their existing behavior.


`CodeBlock` renders only supplied content: pass `code` or pre-rendered
`children`, `lang` when a language tag is wanted, and an `action` for a real
head control. It has no sample command, default language or decorative copy
control. Clipboard access and highlighting belong to the host. `wrap={false}`
retains native keyboard-accessible horizontal scrolling.
