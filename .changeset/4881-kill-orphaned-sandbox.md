---
"@schlessera/brain-ui-sdk": patch
---

A worker killed as soon as its launch resolves no longer leaves its sandboxed program running (#4881). bubblewrap reports the sandbox's PID right after it creates it, but the sandbox arms `--die-with-parent` only once its setup is done, so a supervisor killed in between left the sandbox orphaned: the program started anyway and held the worker's output open until it ended. Once a status-gated worker's supervisor has exited, a sandbox that outlived it is now killed by its verified identity, with `launchAgentWorker` and `launchAgentWorkerAsync` alike. A sandbox its supervisor already reaped is never signalled.
