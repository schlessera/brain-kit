---
"@schlessera/brain-ui-server": patch
---

Draft saves and uploads no longer read stored image bytes to compute byte totals (#4803). A migration replaces the draft-attachment index with one that covers each attachment's size and attached flag, so the host and pool totals read only the index, and a save reads its images' sizes without loading their BLOBs. Drafts still return their images unchanged.
