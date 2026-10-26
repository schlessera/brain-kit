---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits reference-source, managed-worktree and hygiene writes on its SQLite write worker at full durability, including periodic checkpoint observations, while keeping lease, generation and cleanup effects ordered before their callers continue.
