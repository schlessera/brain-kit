---
"@schlessera/brain-ui-sdk": patch
---

The asynchronous direct-spawn maintenance and transport launches (`launchMaintenanceWorker`, `runMaintenanceWorker`) now wait at a start gate before their payload starts (#4301). Stdin, output caps, exit codes and cleanup are unchanged. A caller's timeout still counts from the spawn (zero disables it), and a deadline that passes before release stops the launch with SIGKILL, as the caller's own timer would. An abort before release rejects with its own reason. A bubblewrap that fails its own setup still reports its own exit code and stderr. The gate shell runs before the payload's rlimit prefix and changes nothing in its environment, so the payload keeps its limits, prlimit's own diagnostic and every variable it was given. One intended difference: a gate that fails while bubblewrap is still alive stops it and throws `WorkerHostError`. The synchronous form (`runMaintenanceWorkerSync`) is unchanged.
