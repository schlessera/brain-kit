---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-react": minor
---

Every agent worker now runs under resource limits, so one runaway turn cannot exhaust the host (#1660). `prlimit` sets the process, per-process memory (`RLIMIT_DATA`), file size and open file limits inside the worker before the agent starts. Where the server runs alone in a delegated cgroup v2 subtree, such as a systemd unit with `Delegate=yes`, each worker also gets its own cgroup with `memory.max`, `pids.max` and `cpu.max`. The defaults are far above normal use: 4096 tasks, half the memory the server has (physical memory, or a lower cgroup cap above it), 16 GiB per file, 65536 open files and all CPUs but one. `BRAIN_UI_WORKER_LIMITS` overrides them, for example `memory=8GiB,pids=2048,cpu=2`. A host without `prlimit` (util-linux) now refuses agent turns and names that requirement. `GET /api/status` reports each limit as enforced or absent, with the reason, under `runtime.workerHost.limits` (`WorkerLimitsStatus` in `@schlessera/brain-ui-sdk/protocol`). The agent is told the same limits before it starts. A cgroup limit hit is recorded in the run's Activity next to the step that caused it. A limit that ends the worker fails the turn with the new first-party class `worker_resource_limit`, which names the limit. Backends report hits through the new `resource_limit` activity event.
