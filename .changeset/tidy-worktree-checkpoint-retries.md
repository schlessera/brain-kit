---
"@schlessera/brain-ui-server": patch
---

Keep retrying failed managed-worktree checkpoint releases after their turn ends, with retained charges visible in status until deletion succeeds. Stop retries on host shutdown while preserving unconfirmed leases for recovery.
