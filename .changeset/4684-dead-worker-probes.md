---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-pi": patch
---

Removes worker-runtime code that had no effect: the `probeHomeOverlay` and `probeMaintenanceWorker` probes (one could not succeed), the maintenance envelope's `home.overlay` flag (its only effect was a refusal), the deprecated `home` option of `prepareWorkerSandbox`, which sandbox planning never read and the pi backend no longer passes, an unreachable error branch in sandbox area planning, and the empty `resetRtkProbe` test shim. These names were reachable only through the unsupported `./internal` entry; no worker sees a different sandbox.
