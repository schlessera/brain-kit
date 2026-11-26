---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
---

Register the additive `settings_conflict` failure class for a native runtime that cannot honor a retained setting before prompt release. It uses the existing free-form failure field without an authentication event or login instruction. Persist prompt ownership only after the settings gate releases input, so refused retries leave no pending turns.

Register `session_roster_incompatible` when current mandatory exclusions conflict with retained provider tools. Refuse the incompatible resume rather than changing its roster. Rejected native settings reads keep the named settings refusal, and context migration and writes check encoded size before replacement.
