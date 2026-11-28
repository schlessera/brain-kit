---
"@schlessera/brain-ui-sdk": patch
---

The direct-spawn maintenance and transport launches (`launchMaintenanceWorker`, `runMaintenanceWorker`, `runMaintenanceWorkerSync`) now wait at the same start gate as agent workers before their payload starts (#4301). Stdin, aborts, timeouts, output caps, exit codes and cleanup are unchanged: a caller's timeout still counts from the spawn (zero still disables it), a deadline or an abort that arrives before release stops the launch without ever starting its payload, and a bubblewrap that fails its own setup still reports its own exit code and stderr. One intended difference: a gate that fails while bubblewrap is still alive throws `WorkerHostError`.
