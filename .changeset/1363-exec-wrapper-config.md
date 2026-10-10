---
"@schlessera/brain-ui-server": minor
---

Spawn every brain CLI and repository script through the exec wrapper of the app's own configuration. An app created with an explicit `config` used to launch the brain CLI, `whatsup` and the streaming sync under whatever `BRAIN_UI_EXEC_WRAPPER` the process environment named, so two apps in one process shared one privilege boundary. `ServerConfig` gains optional `exec`, which `resolveServerConfig()` always sets, and `createBrainClient` accepts `exec`. A configuration or client without it keeps the process environment's wrapper, resolved once, and never spawns unwrapped. A relative `BRAIN_UI_EXEC_WRAPPER` now refuses at configuration time instead of failing each spawn, and the cron bin resolves the wrapper once at its entry point.
