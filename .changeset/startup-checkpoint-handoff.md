---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Release unused governed startup checkpoints in the background with bounded ownership, automatic retries, durable diagnostics and reservation waits until space is reclaimed.

Reserve release ownership before acquiring disposable views. Native deletion retains its durable fence and physical charge while allowing unrelated checkpoint requests to proceed outside the deletion lock.
