---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Overlap eligible per-tool journal observations with the next model request. Confirm the worker stop at full-request dispatch, retain every observation and its durability, and withhold the response until the observation and scope pause have committed. Unknown or concurrent work retains the immediate hold.
