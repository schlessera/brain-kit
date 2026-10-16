---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Add human-owner attachment review, journal-backed removal and version-checked Undo with durable per-item receipts. Originals are verified and retained before effects; changed, protected, ignored and uncovered files are refused. Interrupted requests never replay, replacements are never overwritten, and retention expiry removes the Undo offer. Add the bounded core primitives and protocol contracts used by this application boundary.
