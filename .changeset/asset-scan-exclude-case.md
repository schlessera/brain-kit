---
"@schlessera/brain": minor
---

The asset scan now applies `exclude.*` entries to an image or PDF's path as it is on disk. Before, it lowercased the path first, so on a case-sensitive filesystem `dirs: ["drafts"]` also removed the assets under `Drafts/` (while keeping its notes), and `dirs: ["Drafts"]` kept them.

**Effect on an existing brain:** assets under a directory whose case differs from an exclude entry return on the next embedding run (`brain index --embeddings`). Assets under a directory that an upper-case entry names exactly leave the index on the next `brain index`. Notes are unaffected. `brain stats`'s document counts follow the index, so they change as those assets come or go; its `size.corpus` walk already matched the path as it is and does not move. `okf export` scans the disk itself, so it applies the corrected rule at once, before any embedding run.
