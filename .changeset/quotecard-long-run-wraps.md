---
"@schlessera/brain-ui-kit": patch
---

`QuoteCard`: a quote or note with no break opportunity in it — a URL, most
often — now wraps inside the card instead of laying out at its full width and
scrolling the whole transcript sideways on a phone. The quote and note slots
take the kit's existing `overflow-wrap: anywhere`; the source row was already
ellipsised. No prop changes and the `quote` block payload is unchanged.
