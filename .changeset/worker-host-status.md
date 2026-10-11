---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

The server now learns at boot whether its host can run agent workers, instead of finding out on every turn (#1632). Boot probes the agent worker boundary (the restricted envelope too while autonomous work is enabled), logs a failure once with its named requirement, and keeps running. `GET /api/status` reports the latest probe as `runtime.workerHost` (typed as `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), every turn's own probe re-records it, and the new authenticated `POST /api/status/worker-host` re-runs the probe. While the host is unavailable, the app shows a notice above the composer that names the requirement, links the hosting guide's container section and offers "Check again". The composer stays usable. A turn sent anyway is still refused by its own probe, and its failure card now says the server can't run agent turns and shows the requirement, without offering a retry. Every turn still runs the probe: a passing result is never cached.
