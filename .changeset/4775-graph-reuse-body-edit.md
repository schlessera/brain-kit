---
"@schlessera/brain": patch
---

An index run after an edit that changes no link, title or tag no longer recomputes the graph (#4775). The graph tables are rebuilt only when what they are computed from changes: the markdown documents' ids, paths and titles, the link rows, the tags, the graph root and the anchor policy. When a document was indexed after the graph was computed but none of those inputs changed, the run keeps every `graph_*` row and moves `graph_computed_at` forward, so `brain graph` still reports the graph as current. Such a run reports `graphNodes: 0` and `graphMs: 0` in its stats, and layout positions no longer move on a body-only edit. The first index run after upgrading rebuilds the graph once.
