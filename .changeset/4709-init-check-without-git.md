---
"@schlessera/brain": patch
---

`brain init --check` no longer ends with an internal error (exit 2) on a machine without git (#4709). It reports `git.repo: false` and `hooksPath.set: false` and exits 0, the same report it prints when git is present and the directory is not a repository. Core now has one guarded copy of its "is this a git repository" and "read one git config value" probes.
