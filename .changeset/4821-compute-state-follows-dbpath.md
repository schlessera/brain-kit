---
"@schlessera/brain-ui-server": patch
---

`createApp({ dbPath })` now keeps hosted compute state beside the database it opens (#4821): `<dbPath>.compute`, or no state directory (hosted compute off) for `""` and `":memory:"`. It used to derive the directory from the environment's `DB_PATH` (or `./brain-ui.db`) before `dbPath` replaced it. An explicit `BRAIN_UI_COMPUTE_STATE_DIR` still wins. An embedder that passes `dbPath` and binds compute keys no longer sees job records it already has beside `$DB_PATH`.
