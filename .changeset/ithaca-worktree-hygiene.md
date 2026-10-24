---
"@schlessera/brain-ui-server": minor
"@schlessera/brain": patch
---

Review and clean up managed reference worktrees. Release and expiry remove a worktree only when a fresh assessment shows no holder and no work. Retained unfinished work, worktrees whose holder or work cannot be established, and failed removals become host-only hygiene findings: they reuse core's finding IDs and fingerprints and join the human-started review, but never enter `context/hygiene/` or `brain hygiene list`. A private worktree's card names no repository, commit or path. The owner reviews a delegated agent's worktrees; dismissing or snoozing never removes one. A confirmed `delete-worktree` repair is revalidated immediately before it deletes, so a renewal, edit, worker start, replaced root or revoked reviewer refuses it, and capacity is credited only when the pool reports the worktree reclaimed.
