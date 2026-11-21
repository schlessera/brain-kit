---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
---

Recover unpublished copy intents without quarantining healthy hashes or blocking boot under the storage cap, while preserving quarantine for genuinely missing published versions. Refuse reacquired folder plans that no longer match prepared sandbox mounts. Keep retained-consumer and failed-admission cleanup independent of ordinary release slots, transferring only failed deletions to a nonblocking retry owner. Preserve stored legacy conflict lists and the released per-row history contract, with durable conflict relations still stored once per path.
