---
"@schlessera/brain": patch
---

A failed index step in `brain doctor --fix` and `brain sync` now closes the database handle before the error reaches the command (#4710). `sync` used to carry on, committing and pushing the derived caches, with a writable handle still open. `maintain`, `doctor --fix` and `sync` share one index step; what each prints and returns is unchanged.
