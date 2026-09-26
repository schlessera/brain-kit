---
"@schlessera/brain": patch
---

`brain context` no longer holds fewer search hits at a larger budget. Identity and current focus used to take as much of the budget as fitted before any hit was placed, so the budget at which the focus document first fit whole could leave no room for a hit that a smaller budget had held. On the fixture corpus, `ranger` got one hit at 500 tokens, none at 550 or 600, and one again at 700. Both documents now go in first as their summary and lead, the hits are placed against the rest, and only the budget the hits leave grows the documents towards their whole body. A budget too small for both summaries and leads gives them all of it and places no hit, since a hit placed there would be pushed out again as the cut lead grows. The output order (identity, focus, hits, related) is unchanged.
