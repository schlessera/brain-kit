---
"@schlessera/brain": minor
---

Two `brain stats` human-output fixes:
- A brain with no documents but an unreadable vector table now prints the `Embeddings: n/a` line under the empty-state message. Before, it read exactly like a brain with no vectors.
- A health ratio that twenty decimal places could not tell apart from its threshold now prints with enough places to show which side it is on.
