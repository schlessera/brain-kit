---
"@schlessera/brain": patch
---

An index run no longer marks the graph tables current after another connection changed what they are computed from (#4873). When a run reuses the tables, it now hashes their inputs again under the write lock before it moves `graph_computed_at`. If a title, tag or link was committed between the first hash and that write, the run rebuilds the tables. Before, the old tables were stamped as current and `readGraphMeta` reported `stale: false` until the next graph-enabled run.
