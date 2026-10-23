---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

Give workers governed access to managed reference worktrees. A governed or strict turn's workers bind one root-owned worker generation at `/tmp/brain-worktrees`, and a worktree appears there only after the turn journal covers it. Its edits are journaled from the worktree's own checkpoints under scope `reference_worktree` with logical `reference-worktree://<id>/<path>` paths, count toward scope caps and are never reverted into the brain. The generation retires before the turn's final observation and parks its worktrees afterwards. The sandbox note gains fixed worktree guidance. Generations open only when worktree access is enabled by the supported tools, and acquired source is checked out group-writable.
