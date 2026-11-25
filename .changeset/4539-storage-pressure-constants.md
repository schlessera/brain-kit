---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

`@schlessera/brain-ui-sdk/protocol` now exports the Storage pressure policy as named constants: `STORAGE_PRESSURE_LOW_PERCENT` (10), `STORAGE_PRESSURE_CRITICAL_PERCENT` (5), their recovery percentages (12 and 7), the forecast entry days (30 and 7) and recovery days (45 and 10), the recovery observation count (2) and spacing (60 seconds), and the six-hour evidence window. The server computes pressure severity from these same constants, so a client can draw threshold ticks and bands that match the severity it is shown. No value, comparison or payload changes.
