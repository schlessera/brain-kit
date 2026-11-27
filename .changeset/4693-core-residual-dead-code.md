---
"@schlessera/brain": patch
---

`brain --help` now describes `brain module` as "List, lint, enable or disable brain-kit modules and edit their settings", covering every subcommand its help block documents; it said only "List and lint" (#4693). The unused `ensureScratch` guard leaves the source: writes into scratch go through `assertScratchWritable` and `writeScratchFile`, which make the same checks. No `--json` shape or exported name changes.
