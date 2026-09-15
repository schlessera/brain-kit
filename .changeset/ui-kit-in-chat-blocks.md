---
"@schlessera/brain-ui-kit": minor
---

Add the twenty in-chat block and conversation-lifecycle components — the shapes
an answer can take inside a chat transcript, and the surface a model will drive
by tool call.

`StepList`, `MapView`, `TimelineList`, `ScheduleList`, `QuoteCard`, `CodeBlock`,
`LinkPreviewCard`, `ContactCard`, `StatTiles`, `TrendChart`, `Disclosure` and
`FeedbackRow`; `StreamingAnswer`, `SuggestionChips`, `AttachmentRow`,
`InlineToast`, `ComparisonTable`, `RelatedFiles`, `DigestCard` and `EmptyState`.

`MapView` projects real coordinates with Web Mercator and computes its scale bar
from metres-per-pixel at the view's latitude, so the distance it claims is the
distance it draws; `tests/mapview-projection.test.tsx` pins the arithmetic.
`Disclosure` is the kit's one stateful component and is uncontrolled after the
first toggle — `open` seeds it and is then ignored, which is the design's
behaviour and is asserted rather than assumed.

112 new design tokens, and one rename: `--bk-diff-bg-inset` is now
`--bk-inset-well-bg`, since three components share it. `@schlessera/brain-ui-kit/styles.css`
(or `theme.css`) remains mandatory — every colour resolves through a `--bk-*`
custom property with no fallback.
