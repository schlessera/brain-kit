---
"@schlessera/brain-ui-server": patch
---

Give operational backup export the server's five-second SQLite busy timeout so a temporary database lock does not immediately fail the recovery command.
