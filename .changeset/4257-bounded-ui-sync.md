---
"@schlessera/brain-ui-server": minor
---

A UI sync can no longer hold the brain as "already running" until the server restarts (#4257). Everything between accepting `POST /api/brain/sync` and the sync process starting (the CLI probe, the writer gate and the worker launch) is bounded at 120 seconds. Past it the stream ends with `{ type: "done", success: false, reason: "launch_timeout" }` and the next sync is accepted. A process that exits while a descendant keeps its output open releases the brain after a 10-second grace. A 409 now says how long the current sync has held the brain (`heldMs`, also in the message). Each UI sync is recorded as an Activity run (`jobName: "ui-sync"`) with its exit status and last error lines, and a failure is logged as `ui sync failed`, so the reason survives a disconnected browser.
