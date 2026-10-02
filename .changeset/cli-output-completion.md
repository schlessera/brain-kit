---
"@schlessera/brain": patch
---

Finish CLI stdout and stderr writes before exiting so large piped responses remain complete, while unrelated provider sockets and timers cannot delay a finished command.
