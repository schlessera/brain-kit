---
"@schlessera/brain-common": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Give each hosted worker a private, filesystem-limited turn-temp tmpfs,
defaulting to 256 MiB, with whole-lifetime aggregate admission shared by both
backends. Keep XDG writes inside it and real HOME read-only; retain a directory
descriptor so linked deliverables can still be promoted after exit.

Add the `turn_temp` tool for usage and scoped purge, preserving output-linked
files unless named paths explicitly force their removal. Record purge governance
events and explain the allowance, 80% warning and out-of-space recovery in the
sandbox note. Add host overrides `BRAIN_UI_TURN_TEMP_BYTES` and
`BRAIN_UI_TURN_TEMP_BUDGET_BYTES`; unavailable capacity refuses as
`worker_state_busy` with Retry.
