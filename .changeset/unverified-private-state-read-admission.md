---
"@schlessera/brain-ui-server": minor
---
Refuse boot with OperationalStateAliasVerificationUnavailable and the original scan cause when bounded private-state verification cannot finish. Later admission refuses both governed and strict turns with private_state_unverified, without a strict fallback, and recovers on the next verified check.
