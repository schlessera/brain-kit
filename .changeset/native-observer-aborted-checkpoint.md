---
"@schlessera/brain-ui-server": patch
---

Server shutdown no longer fails intermittently with "native checkpoint(s) remain retained after shutdown" (#3521). When a journal observation's signal was already aborted, for example because shutdown began while the observation was starting, the observer kept a checkpoint id that the native lease owner had refused to record. That id could never be released. The observer now checks the signal before keeping the id, so a refused checkpoint is never retained.
