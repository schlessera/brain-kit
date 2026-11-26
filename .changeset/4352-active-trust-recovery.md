---
"@schlessera/brain-ui-server": patch
---

An active turn now recovers by itself after `trusted_sources` in `context/policies/governance.md` is edited by hand or synced while the turn runs. Before, every admission that read trust (model relays and unrelated destinations included) kept refusing until the next turn or a Settings read. Now the first refused read schedules one bounded background reconciliation; once the file and the durable trust projection agree, admissions resume. A removed source rule still ends its open connection with `source_trust_changed`, and unrelated trusted sources keep streaming.
