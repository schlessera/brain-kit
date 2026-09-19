---
"@schlessera/brain-ui-kit": minor
---

The sixth design drop: a question is an exchange, a mask is a receipt.
`AskUserCard` carries `state` — `pending` (options, one focus stop),
`answered` (the chosen answer, checked and in the accent, with when; the
alternatives are gone, not dimmed) and `typed` (the user answered in the
composer; the card quotes what the agent took, behind a neutral border) — all
three at full contrast, plus `otherOpen` / `otherPlaceholder` /
`onOtherSubmit` for a real free-text field in place of the Submit row, and
`answer` / `answerMeta`. Its heading is now the accent itself rather than the
accent at 85%. `FileRow` binds ← / → on `treeitem` rows through `onFold`, and
its name, `TraceSteps`' step text, `SearchResultCard`'s path, `ListRow`'s
title and the palette's rows carry the full value as a `title` — a row that
opens the record may ellipsise, a receipt may not: `InlineToast`'s target now
wraps. `MapView` clamps its viewport to 110–260px so the server's geometry
envelope is bounded; a screen that passed `height={88}` renders at 110. The
catalog's §13 mask receipt is composed in `Decisions/Question and mask`.
