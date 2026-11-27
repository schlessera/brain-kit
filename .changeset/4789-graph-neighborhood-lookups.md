---
"@schlessera/brain": patch
---

The local graph (`readGraphNeighborhood`, the hosted Local-graph panel) and graph meta no longer load every edge in the brain per request (#4789). A neighborhood expands each node through the `links` primary key and the `links(target_id)` index and selects its scene's edges by lookup from the nodes it kept; the whole-graph edge query and graph meta's edge count build each set of graph nodes once instead of reading two `documents` rows per edge. Counts, caps, result shapes and every result below the 1,500-node neighborhood budget are unchanged. One observable difference: a neighborhood walk now visits out-neighbours in ascending id, then in-neighbours in ascending id, so when a supported-API neighborhood stops at its 1,500-node budget, the nodes kept are the first ones in that order rather than in the SQLite engine's edge order.
