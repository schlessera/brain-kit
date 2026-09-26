---
"@schlessera/brain": minor
---

An alias counts as a name. A document's `aliases` now have their own full-text column, weighted like its title, instead of riding in the tags column at a tag's weight. A query that is exactly a document's title or one of its aliases, ignoring case and spacing, puts that document first in `fts` and `hybrid` search, whatever the lanes scored. When several documents match exactly, they keep their order among themselves. `brain audit` gains a `duplicate-title` finding (`info`) on each current document whose exact title another current document shares, naming the others.

**Schema 14.** `brain.db` recreates `documents_fts` with the new column, filled from the documents table at once, and the next `brain index` rewrites every markdown row with its aliases. Tag search and `--tag` filtering are unchanged.
