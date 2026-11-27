---
"@schlessera/brain": patch
---

`brain index --force --embeddings` no longer holds every stored markdown vector in memory while it rebuilds (#4783). The vectors it reuses for unchanged text are copied, one row at a time, into a temp table keyed by a hash of that text, read back only for the chunks being written, and the table is dropped when the run ends, also when it fails. Which vectors are reused and how many provider calls a forced run makes are unchanged.
