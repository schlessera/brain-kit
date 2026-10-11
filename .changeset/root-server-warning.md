---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

A server running as root now says so (#1638). Its agent workers run as root too, and although they have no capabilities and a read-only `/proc`, they can still read root-owned files and connect to root-owned and abstract Unix sockets. The server still boots. It logs that warning once at boot, reports it on `GET /api/status` as `runtime.workerHost.rootServer` (typed on `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), and the app shows a standing notice above the composer that links the hosting guide's section on running the server as a non-root user.
