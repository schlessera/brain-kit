---
"@schlessera/brain": minor
---

The vector table can now give back the space deleted vectors leave behind. sqlite-vec 0.1.9 never reuses the slot of a deleted vector, and `VACUUM` cannot reclaim it, so a brain that is re-indexed incrementally keeps growing. `brain index --compact` rebuilds `vec_chunks` from its live rows and then runs `VACUUM`. It makes no provider call, and `--json` reports `{ compacted, before, after }`. `brain maintain` runs the same step as a new `vectors` step, but only when fewer than half the slots are live and at least one internal chunk would be freed. `brain stats --json` reports `size.db.vectorSlots: { live, allocated }`, and `allocated` is `null` when sqlite-vec cannot be loaded.
