---
"@schlessera/brain-ui-server": patch
---

A reference worktree's journal observer no longer keeps a checkpoint the native lease owner refused before recording its lease. An abort while the checkpoint was being recorded in the worktree ledger, or while the owner settled the worktree's interrupted release, left the identity retained, and the observer's shutdown then failed with "native checkpoint(s) remain retained after shutdown". The lease owner now acknowledges one release of an identity it refused before any lease existed, without asking the pool to delete anything, and a ledger record that fails never reaches the pool. A checkpoint whose lease was recorded keeps its retryable cleanup, and a pool identity with no recorded lease still cannot be deleted.
