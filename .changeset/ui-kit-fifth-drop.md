---
"@schlessera/brain-ui-kit": minor
---

The fifth design drop. `CommandPalette` takes a real query input
(`onQueryChange`, `placeholder`, combobox semantics), `cost` and `why` rows
(a spend chip; a disabled row with its reason printed rather than omitted),
and a list that scrolls. `Composer` is kit-owned: `state` (ready · streaming ·
reconnecting · offline) drives placeholder, hint and the trailing control
together, with `onStop`, a provider chip in the hint line (`provider`,
`onProvider`), recall chips above the field (`recall`, `onRecallRemove`), an
attach button that is a menu trigger, and the offline reason (`blockedWhy`).
`MapView` takes `accuracyM` (the span becomes `max(spanKm, 6 × accuracy)` and
the uncertainty is drawn as a ring at true scale, not below 14px), `note`
(inside the card, under a hairline) and `maxWidth` (default 420). The nav
defaults are the five destinations — Chat · Actions · Files · Graph ·
Settings on the rail, Settings folded into More on the bar — and the
assembled chat screen closes with `SuggestionChips` while the weekly review
carries the `InlineToast` receipt for the last policy written.
