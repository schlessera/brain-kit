---
"@schlessera/brain-ui-server": patch
---

Gated dispatcher decisions that approve an exact change now offer `apply` and `dismiss`, the one-commit shape the Actions card renders, instead of `apply` and `cancel`. With two commits the card treated the answer as ambiguous and showed a bare "Resolved" instead of the exact "Approved · queued …" receipt. Choices without an approvable operation keep their explicit cancel. Autonomous dispatch stays disabled in `createApp`.
