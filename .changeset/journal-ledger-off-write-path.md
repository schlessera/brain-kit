---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Changed: a journal write no longer truncates the SQLite WAL first; admission charges the WAL as it stands and truncates only when that would refuse. Commits stay `synchronous=FULL` (#2789).
Changed: journal capacity measurement walks only the journal's own SQLite b-trees, not the whole database.
Changed: a journal row changed outside capacity accounting on the server's connection is refused.
Changed: the server's maintenance temporary-storage ledger stays open between reservations instead of opening and closing its database each time.
