---
"@schlessera/brain-ui-server": patch
---

`GET /api/activity/rollups` now floors its `days` parameter at one whole day,
as `/api/activity/stats` already did. A negative `days` used to push the window
start into the future and answer an empty rollup; it now covers the last day.
Fractions truncate to whole days. The default (7) and ceiling (90) are
unchanged.
