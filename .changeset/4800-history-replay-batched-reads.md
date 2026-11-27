---
"@schlessera/brain-ui-server": patch
---

History replay reads every turn's journal summary and saved budget receipt with one statement per kind for the whole chat, instead of about seven statements and two receipt parses per turn (#4800). Resume, reconnect, the session route, handoff and live voice history return the same messages as before.
