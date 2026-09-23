---
"@schlessera/brain": minor
---

The asset scan now applies `exclude.*` entries to an image or PDF's path as it is on disk. Before, it lowercased the path first, so on a case-sensitive filesystem `dirs: ["drafts"]` also removed the assets under `Drafts/` (while keeping its notes), and `dirs: ["Drafts"]` kept them.

**Effect on an existing brain:** assets under a directory whose case differs from an exclude entry return on the next embedding run (`brain index --embeddings`). Assets under a directory that an upper-case entry names exactly leave the index on the next `brain index`. Notes, `brain stats` and `okf export` are unaffected except that `okf export` now selects the same assets the index holds.
