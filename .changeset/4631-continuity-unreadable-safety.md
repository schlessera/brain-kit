---
"@schlessera/brain-ui-server": patch
---

A Google session allowance no longer stops brain-wide safety recording recovery when its safety scope holds a record payload or detector acknowledgement that SQLite's `json_valid` rejects (#4631). The continuity check and the safety projection now treat such a value the same way, as unreadable. The check no longer fails the write it runs in, so recovery at boot or by the owner clears the latch again. The projection no longer reads trust from a JSON5 or JSONB payload, or from an acknowledgement nested past SQLite's limit. It fails closed for that scope instead, so an allowance kept there cannot be used while the value remains, and the scope never reads as normal. An acknowledgement that is valid JSON but not an array now acknowledges no detector.
