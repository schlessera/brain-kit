---
"@schlessera/brain-ui-sdk": patch
---

The worker bootstraps load none of the protocol module, the safety schemas, the host-side egress proxy or zod (#4796). `worker-entry` loads the maintenance reservation ledger only for a launch that carries a reservation, and `egress-worker-entry` and `egress-connect` read the egress socket path from a constants leaf. `FIRST_PARTY_FAILURE_CLASSES`, `SESSION_SAFETY_CAPABILITY` and `SAFETY_READ_CAPABILITIES` are declared in zod-free leaves, so `@schlessera/brain-ui-sdk/protocol` no longer loads zod. Every entry point exports the same names with the same values.
