---
"@schlessera/brain": minor
---

Make `brain audit --fix` deterministic with no completion-provider call. Repairability comes only from the available registry capability, with additive optional `repair` metadata in the JSON results. The command applies nothing and never emits replacement `fix` text.
