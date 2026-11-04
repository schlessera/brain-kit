---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---
An automatic index refused at maintenance admission because the temporary-storage budget is busy, for example by a turn's scratch check, now stays pending and runs once the budget frees instead of failing. A turn's scratch check and an index you request keep their current outcomes. The busy message names what holds the budget by kind (index, scratch query, git, sync, probe or command), without paths or identities.
