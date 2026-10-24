---
"@schlessera/brain-ui-react": patch
---

The hygiene review card no longer offers "Open file ›" for a managed-worktree finding. Its path, `reference-worktree://<worktree id>`, is a logical identity rather than a brain file, so the card shows it as text and keeps the host's explanation; Markdown findings still open their file.
