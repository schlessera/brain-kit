---
"@schlessera/brain-ui-kit": minor
---

`ui-kit` gains fourteen more components, ported from the design drop: the rows
and lists — `ListRow`, `ChoiceOption`, `FileRow`, `QueueItemRow`, `FilterRow` —
the evidence surfaces — `Receipt`, `TraceSteps`, `DataTable`, `BarList`,
`SearchResultCard` — and the four decision surfaces, `ActionCard`,
`AskUserCard`, `ApprovalCard` and `NotificationCard`.

Seven of them ship the design's interaction states. Hover, pressed and focus are
CSS rules in `theme.css` with the per-component values travelling as `--hv-*`
custom properties, and **all of it is gated on a handler**: a row with no
`onClick` gets no role, no tab stop, no hover and no focus ring, so a static list
never pretends to be clickable. That is an API contract, not styling. Rows take a
new `.bk-row` class rather than `.bk-control`, because the design draws a row's
focus ring INSIDE the row — an outline at +2 on a full-width row is clipped by
the first ancestor with `overflow: hidden`, which is every `Surface`.

Keyboard activation comes with the roles: Enter and Space on every
`role="button"`, ↑↓ inside `ChoiceOption`'s radio group, ←→ across `FilterRow`'s
tabs with activation following focus. `FilterRow` and `AskUserCard` also render
the `tablist` and `radiogroup` their children's roles require.

`ActionCard`, `QueueItemRow`, `SearchResultCard` and `FileRow` delegate their
loading, empty and error rendering to `Placeholder`, each supplying its own copy
through overridable `stateMessage` / `stateDetail`.

`Button` gains an optional `style` prop, merged onto its own root, and
`ApprovalCard`'s two buttons now split their row evenly instead of overflowing
the card. `block` means `width: 100%` *and* `flex: none`, so two default Buttons
in a flex row each demand the whole row and neither yields. A row of
content-sized buttons passes `block={false}`; a row that should split evenly
passes `style={{ flex: "1 1 0", width: "auto" }}`.

Forty-one new tokens, all in `theme.css` — no `.tsx` in the package contains a
colour literal. `@schlessera/brain-ui-kit/styles.css` (or `theme.css` into your
own Tailwind v4 build) remains MANDATORY: every colour resolves through a
`--bk-*` custom property with no fallback, so without the stylesheet the
components render with no colour at all.
