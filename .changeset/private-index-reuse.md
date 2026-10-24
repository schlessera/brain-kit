---
"@schlessera/brain-ui-server": patch
---

A provider-restricted hosted turn no longer rebuilds its private search index from scratch on every turn (#2833). The server keeps one host-owned build per policy, mask set and recipient, bound to the native checkpoint it was built from, and reuses it when the turn's checkpoint provably indexes to the same thing: unchanged, or only new notes outside the masked folders, which the incremental index adds. Any other change, such as a note edited, removed or moved into a masked folder, still builds the index from nothing, so no removed or masked text survives in it.
