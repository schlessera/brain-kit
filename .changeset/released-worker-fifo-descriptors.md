---
"@schlessera/brain-ui-sdk": patch
---

A maintenance command, including one aborted while its worker pipes were being created, now waits, for up to 5 seconds, until every descriptor on its worker's three FIFOs is closed before it finishes (#2862). Bun's file streams read and write through their own duplicate of each descriptor and close it later on Bun's thread pool, so on a busy host a finished or refused command could leave them open for a while. An abort that lands during that wait still refuses the result. The internal `MaintenanceWorker` and `LaunchedWorker` gain `released()`, which resolves once none of the worker's stdio descriptors is open in the server, or after that bound.
