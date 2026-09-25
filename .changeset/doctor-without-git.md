---
"@schlessera/brain": patch
---

`brain doctor` no longer crashes with no report when git is not installed. The `git-hooks`, `privacy` and `scratch` checks now report `warn` with "git is not installed or not on PATH", and every other check still reports. A check that throws for any other reason becomes a `warn` naming the error instead of aborting the battery. `brain doctor --fix` and `brain setup` finish too, and `setup` says it skipped the git hooks because git is missing.
