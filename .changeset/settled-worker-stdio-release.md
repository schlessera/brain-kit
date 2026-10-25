---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": patch
---

A Claude or pi agent turn, a pi worker whose initialization was refused, and a streaming maintenance launch now finish only once every descriptor on their worker's stdio FIFOs is closed in the server, or after the 5 second bound of the worker's `released()` (#2863). Bun closes its own duplicates of those descriptors later, on its thread pool, so on a busy host a finished turn could report itself done with them still open. A streaming launch keeps its output slot and writer gate until then, but reports the worker's exit as before: a caller that reads the streams only after the exit is not held up. The worker's stdin is now closed once it has exited.
