---
"@schlessera/brain": patch
---

An index run no longer deletes and rewrites the whole `links` table, with one lookup per link (#4780). Every run still re-resolves every link against the whole corpus, but it now writes only the rows that changed: a link that left a document, a new one, or one that resolves to another document. A run in which no link changed, including a body edit that keeps its links, writes no `links` row, and the `supersedes` pass updates only rows whose resolved target changed. Document bodies are streamed instead of loaded at once. The contents of `links` and `supersedes` after a run are unchanged.
