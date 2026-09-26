---
"@schlessera/brain": minor
---

`brain context` now gives each search hit as the section its best-matching chunk comes from, not a one-line snippet of the document's opening. The section is read from the file: the whole `##` section (or the text before the first one) as the markdown parses, with its headings, setext included, moved below the section's own, and a fence or HTML block left open at its end closed. A hit, section or snippet, takes at most 40% of the budget; a longer section is cut at a block boundary, and one that cannot keep a block falls back to the snippet. `hybridSearch` gains a `chunks` option that fills `SearchResult.chunks` with each result's chunks that match the query through the chunk full-text index, and `brain search --chunks` returns them (an empty list on a filter-only search). Without the flag, the output is unchanged.
