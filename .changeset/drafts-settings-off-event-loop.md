---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits composer drafts, voice transcription claims and settings on its SQLite write worker at FULL durability. Draft reads wait for accepted-message tombstones, providers dispatch only after their transcription claim commits, and settings replies see committed preferences while standalone and cron callers keep their inline behavior.
