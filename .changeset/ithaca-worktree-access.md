---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

Managed reference worktrees get their host lifecycle, worker access and journal coverage. A worktree is a writable snapshot of authorized shared source at a fixed reported commit. A governed or strict turn's workers bind one root-owned worker generation at `/tmp/brain-worktrees`, and a worktree appears there only after authority is rechecked and the turn journal covers it. Its edits are journaled from the worktree's own checkpoints under scope `reference_worktree` with logical `reference-worktree://<id>/<path>` paths, count toward scope caps and are never reverted into the brain. Only explicit access, resumption or renewal resets the three-day inactivity clock; a live worker keeps its worktree past expiry, unknown liveness keeps ownership, and release or expiry records cleanup eligibility facts without deleting anything. The sandbox note gains fixed worktree guidance. Generations open only when worktree access is enabled by the supported tools, and acquired source is checked out group-writable.
