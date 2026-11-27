---
"@schlessera/brain": minor
---

The index schema goes to version 16 (#4787). It adds one index, on `documents(indexed_at)`, so the newest index run that every supported query and the graph's staleness check read is a lookup instead of a read of every document body. A writable open adds it from the rows already there: no reindex is needed, and no table or column changed. As with every schema bump, a `brain` package older than this one refuses an index at version 16 until it is upgraded.
