---
"@schlessera/brain": patch
---

A supported-API graph scene over its 20,000-edge cap (`readGraphClusters`, `readGraphDiscovery`, `readGraphNeighborhood`) now breaks ties between edges whose weaker ends rank alike by (source, target) id, so which edges survive no longer depends on the order the engine returned them in (#4877). It matters most on an index without graph metrics, where every rank is 0. Over the cap, a scene's edges are ordered by the weaker end's pagerank, highest first, then by (source, target); this holds for neighborhoods too, so a neighborhood under its 1,500-node budget with more than 20,000 internal edges keeps the first 20,000 edges in that order. Scenes under the cap, and the CLI, which has no cap, are unchanged.
