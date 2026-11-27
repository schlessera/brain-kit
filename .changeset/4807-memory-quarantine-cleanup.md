---
"@schlessera/brain-ui-server": patch
---

The temporary quarantine directory an in-memory database gets is removed when the host execution is released, on app close and on a boot that fails after it was created (#4807). Before, every boot with `DB_PATH=":memory:"` left an empty `brain-ui-quarantine-*` directory in the temporary root. A file-backed database's `brain-ui-quarantine` directory beside it is never removed.
