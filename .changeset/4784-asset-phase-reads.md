---
"@schlessera/brain": patch
---

The asset step of `brain index --embeddings` no longer holds the database write lock while it reads and hashes changed images and PDFs, and no longer keeps every changed asset's bytes in memory until it is described (#4784). Assets are read and hashed before the write transaction opens, and each is read again when its description batch starts, so at most one batch of files is in memory. An asset rewritten during the run is not described under its old hash: it keeps its placeholder and is described on the next embeddings run. Rows, descriptions and cache lines are otherwise unchanged.
