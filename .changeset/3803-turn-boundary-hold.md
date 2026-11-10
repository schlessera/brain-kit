---
"@schlessera/brain-ui-server": patch
---

A session's history read between a turn's result and the end of its teardown now waits for that turn's boundary. Before, it could replay the answer without its turn id, so a tracked session could never clear as seen. The wait is per session and bounded by the existing boundary deadline.
