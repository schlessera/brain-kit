---
"@schlessera/brain": patch
---

A targeted index run (`IndexOptions.paths`, used by `brain_add`, `brain_update` and `brain_archive`) now reads the index's document rows again inside its write transaction (#4899, #4873). If another connection committed a document in between, the run writes nothing and runs as a complete index instead. Three failures are gone: the run failed with `SQLITE_CONSTRAINT_PRIMARYKEY` when another connection indexed a named path first; a link to a note indexed by another connection was stored unresolved; and a row another connection wrote for a deleted named path stayed searchable.
