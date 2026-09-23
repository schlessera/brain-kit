---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": minor
---

The server now knows which Claude Code ran.

- **At boot**, `createApp()` probes the binary a turn would spawn: the one the Agent SDK selects, run through the exec wrapper with a turn's environment. It refuses to start when that binary is missing or will not answer `--version`, instead of failing the first turn. It warns, naming both pairs, when the runtime is not the Claude Code / Agent SDK pair the backend was measured against (`MEASURED_RUNTIME`).
- **Per turn**, each run's root span records the Claude Code version that ran and the SDK version. It also records the credential the CLI selected and the billing mode that credential implies. That mode is checked against the profile's policy: a profile without its own credential requires the subscription, and a run that contradicts it is flagged, with a WARN log.
- **Auth failures** (`authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, and a turn the subscription check refused) are recorded as their own failure class.
- **Model discovery** now reports a refused credential as an auth failure instead of returning an empty roster.
- **`/api/status`** (behind the auth guard) gains `runtime`: what boot found, what the last turn ran on, and the last auth failure.

`BackendActivityEvent` gains `runtime_observed` and `auth_failure`. `BackendModule` gains the optional `probeRuntime`.

**Host impact:** a host whose `CLAUDE_CODE_PATH` (default `/usr/local/bin/claude`) names no working binary now fails at boot rather than on the first turn.
