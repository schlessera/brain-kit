---
"@schlessera/brain-ui-react": minor
---

A chat link or image whose scratch file has been cleared now reads as expired instead of opening a "File not found." error (#1657). The link keeps its words, followed by a muted "expired", and no longer opens anything; an image becomes a small placeholder holding its alt text and the same label. Both carry "expired" in their accessible names. Opening such a file in the viewer shows "This file has expired" rather than an error. Only files under `.brain/scratch/` are checked, with one `HEAD` request on the existing raw files route per file; links elsewhere keep their current not-found behaviour.
