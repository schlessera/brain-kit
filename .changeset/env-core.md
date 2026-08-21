---
"@schlessera/brain": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-scrape": patch
"@schlessera/brain-module-images": patch
"@schlessera/brain-module-jobs": patch
"@schlessera/brain-render-puppeteer": patch
---

Unify boolean environment parsing across all packages: every boolean variable
now accepts 1/true/on/yes and 0/false/off/no (case-insensitive, trimmed), and
an unset, empty, or unrecognised value falls back to the variable's documented
default instead of being misread. Defaults and directions are unchanged;
previously `"1"`-only flags (the Chrome sandbox switches, `TRUST_PROXY`,
`BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`,
`BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`) accept the full truthy set, and the disable
set for `BRAIN_UI_REVERSE_GEOCODE` / `BRAIN_UI_MODEL_DISCOVERY` gains `no`.
`NO_COLOR` keeps its presence-based contract. Published descriptor types
(`ENV_VARS` shapes) are unchanged.
