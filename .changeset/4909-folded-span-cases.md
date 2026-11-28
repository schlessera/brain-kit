---
"@schlessera/brain": patch
---

Context briefings widen two more folded chunks to their whole span. An oversized section the indexer repacks into a single chunk now records its source lines, and a folded lead whose first line holds only a nonbreaking space is placed where the indexer starts it. The chunker version is bumped, so the next index run re-chunks every markdown document once.
