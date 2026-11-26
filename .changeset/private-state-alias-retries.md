---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---
Retry private-state alias checks after filesystem churn. A persistent failure refuses boot with OperationalStateAliasVerificationUnavailable and its underlying cause; a later incomplete admission check reports private_state_unverified and the next verified check recovers automatically.
