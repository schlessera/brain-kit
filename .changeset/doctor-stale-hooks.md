---
"@schlessera/brain": patch
---

`brain doctor`'s `git-hooks` check now compares each installed hook in `core.hooksPath` with the one the package ships. It warns when a hook differs or is missing, and names it. Hooks are copies, and an upgrade never updated them, so a brain could keep running an old `post-commit`. After upgrading, run `brain doctor --fix` or `brain setup` to reinstall the packaged hooks. Edits you made to a hook are replaced.
