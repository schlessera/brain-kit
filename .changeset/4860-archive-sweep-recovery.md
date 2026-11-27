---
"@schlessera/brain-backend-claude": patch
---

The daily Claude transcript archive sweep no longer re-reads every manifest and re-verifies every completed archive (#4860). Its recovery pass reads the manifests once, skips an archive with no live file left, and rewrites `index.json` at most once, only when a crash lost an index write. A failure recovering one archive, such as a damaged archived copy, is logged for that session and no longer stops the sweep from archiving other idle sessions; no live file of the failing session is removed.
