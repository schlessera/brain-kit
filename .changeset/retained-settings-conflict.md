---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
---

Register the additive `settings_conflict` failure class for a native runtime that cannot honor a retained setting before prompt release. It uses the existing free-form failure field without an authentication event or login instruction. Persist prompt ownership only after the settings gate releases input, so refused retries leave no pending turns.
