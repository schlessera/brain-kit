---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
---

BREAKING: `createApp`, `probeClaudeRuntime` and `BackendModule.probeRuntime` now return promises; migrate callers to `await`.

Boot version probes now cancel at their five-second deadline with bounded cleanup.
