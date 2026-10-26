---
"@schlessera/brain-ui-server": patch
---

Speed up ordinary turn-journal object collection by indexing object pins by hash. The index is built only after reserving its database and WAL growth within the existing journal cap, with sorting in memory and foreign-key enforcement enabled. A near-cap journal defers the upgrade, keeps its existing integrity-checked expiry and collection path, and retries after collection frees enough capacity or on restart. Retention and pin/reservation ownership rules are unchanged.

Operational backups preserve their canonical schema by omitting this derived index. A restored journal admits and rebuilds it only when capacity allows.
