---
"@schlessera/brain-ui-server": patch
---

Cron jobs and cron module discovery now check the same private-state layout as the server (#4498). One function derives it for all three: the inbox poke token file, the storage transfer cache, the turn journal, the native lease database, the web executor state and, when configured, the compute state directory. Before, cron checked only the lease database and the UI database, so an alias of the turn journal (or any other skipped path) into the brain went unnoticed by cron while the server refused it. Cron now refuses that host as the server does. The cron runner reads `BRAIN_UI_INBOX_POKE_TOKEN_FILE`, `BRAIN_UI_COMPUTE_KEYS` and `BRAIN_UI_COMPUTE_STATE_DIR` for this and carries them in the emitted runner environment; no scheduled job receives them.
