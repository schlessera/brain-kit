---
"@schlessera/brain-backend-pi": patch
---

A pi turn now writes a server-applied effect's replay receipt only when what it stores changes (its anchor, its output text or its error state). Before, every transcript snapshot rewrote the session's replay file once per receipt, so a turn with many effects did a quadratic number of whole-file rewrites. The stored receipts are unchanged.
