---
"@schlessera/brain-ui-kit": patch
---

Internal: kit components read a tone's colour from `accent` at the use site, or through one internal helper for value tones, instead of a private per-component table (#4728). Rendered colours are unchanged for every tone a component accepts. A tone that is no accent at all still reads as the component's fallback colour; a component whose tone type is a subset of the accents (`QuoteCard`, `ContactCard`, `Toggle`, `EmptyState`, `InlineToast`, `AttachmentRow`, `SuggestionChips`, `Label`, `DataTable`) now draws any other accent it is given in that accent's colour, where it drew its fallback before.
