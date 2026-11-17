---
"@schlessera/brain-ui-server": patch
---

A provisional dialogue archive that binds into an existing session no longer gets a second pending-write budget while that bind is in flight (#3215). Both routes that bind it through a fresh owner — binding an inactive conversation, and adopting a provisional chat on a turn's first `session_info` — now count their pending observations and bytes against the archive they merge into. The thresholds, stored records, coverage and wire messages are unchanged; a burst that used to fit under two budgets is now refused at one, as `queue_pressure`.
