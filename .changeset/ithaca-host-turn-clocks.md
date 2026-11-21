---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Record inference relay boundaries and per-request provider-reported prompt-cache token counts, observation holds, closing steps in the additive openSubPhases field and build identity in host timing evidence, without changing provider conversations or hold scheduling.

Confirm clock completion only from successful work: retain physical worker-control evidence through cleanup, report failed or pending scope/replay writes as incomplete, preserve causal hold identities, and emit no delta for an unchanged terminal replay.
