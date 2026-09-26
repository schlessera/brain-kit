---
"@schlessera/brain": minor
---

`brain context` now gives each search hit as the section its best-matching chunk comes from, not a one-line snippet of the document's opening. The section is the chunks under the same `##` heading, in order, with their `###` headings kept. It is capped at 40% of the budget, cut at a block boundary beyond that, and falls back to the snippet when it does not fit. `hybridSearch` gains a `chunks` option that fills `SearchResult.chunks` with each result's matching chunks, and `brain search --chunks` returns them. Without the flag, the output is unchanged.
