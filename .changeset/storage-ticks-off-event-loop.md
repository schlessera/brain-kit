---
"@schlessera/brain-ui-server": patch
---

Changed: Commit storage history and notice ticks on the SQLite write worker at FULL durability, preserving buffered observations and waiting for final history writes during shutdown.
