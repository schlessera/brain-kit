---
"@schlessera/brain": minor
"@schlessera/brain-module-travel": minor
"@schlessera/brain-module-speaking": minor
---

Add standalone travel with canonical journey, day-trip and place formats and a lossless configuration migration.

Pre-1.0 break: speaking stops contributing travel taxonomy and plan-travel. Install and enable the matching travel module, migrate travelParty with `brain travel migrate`, then restart and sync skills; existing document paths, types and links are preserved.
