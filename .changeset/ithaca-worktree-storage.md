---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Give the native reference pool managed-worktree storage. `poolCheckpoint` takes a read-only snapshot of a writable worktree, `poolDelta` streams metadata deltas between two checkpoints of one worktree, and `poolReadCheckpoint`, `poolStatCheckpoint` and `poolListCheckpoint` read them through the fixed worker-UID reader. Access generations (`poolAccessOpen`, `poolAccess`, `poolPark`, `poolAccessClose`) move a worktree into or out of one root-owned directory that a running worker binds whole, so a grant appears without a new mount; `poolRelease` refuses a worktree a generation still holds. Pool records gain the `checkpoint` purpose and an `access` field, the pool's `access` directory joins the worker masks, and reclaimed checkpoint identities are forgotten.
