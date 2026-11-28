---
"@schlessera/brain-ui-react": patch
---

A device snapshot that changes only the work context no longer commits it after the root is locked or disposed (#4891). Locking or disposing now aborts that write's transaction, as the draft path already refused inside its own.
