---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": minor
---

Keep reconciling refused worker cleanup and unreadable compute jobs without a restart, retaining their reservations until confirmation. Retry superseded checkpoint cleanup without stopping active turns unless the retained-checkpoint bound blocks a safe observation. Record cleanup causes and recovery in Activity, and expose durable checkpoint cleanup diagnostics in authenticated status.
