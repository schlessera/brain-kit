---
"@schlessera/brain": patch
---

Context briefings now widen a search hit whose best chunk merged a short section into its neighbour, when the match cannot be placed in one of its sections. Before, such a hit kept only its one-line snippet even with budget to spare, so a scoped briefing over the project status files left out the raft's next action and pointed at a targeted read instead. Now, when the hit's share of the budget and the budget left both fit, the hit is every section the chunker merged into that chunk, in source order, each under its own `####` heading, and coverage reports it as a `section`. A span that does not fit is never cut: the hit keeps its snippet, and coverage still marks it partial. A match that one section holds still expands to that section alone, and unfolded chunks are unchanged.
