---
"@schlessera/brain-ui-server": patch
---

A module settings, enable or disable call that the `brain` CLI fails now reports `brain module settings failed …` (or `module enable`, `module disable`) instead of `brain hygiene failed …` (#4723). Only the error text changes; the module routes keep their status and body shape.
