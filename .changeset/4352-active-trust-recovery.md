---
"@schlessera/brain-ui-server": patch
---

An active turn now handles an edit or sync of `trusted_sources` in `context/policies/governance.md` while it runs. Before, every admission that read trust kept refusing until the next turn or a Settings read, model relays and unrelated destinations included, and an open stream from a removed source kept running. Now, within about a second, the turn keeps trusting only the rules the edit left unchanged. A removed or retargeted source's open connection ends with `source_trust_changed`, while unrelated trusted sources keep streaming and model relays stay admitted. A background reconciliation then publishes the new trust revision, and newly added rules apply only after that.
