---
"@schlessera/brain": patch
---

`brain doctor --fix` no longer runs the whole check battery twice (#4794). After applying fixes it re-runs only the checks an attempted fix can change, and keeps the first result of the rest: `runtime`, `version`, `privacy`, `git-storage`, `tracked-leftovers` and `tracked-media` run once, so `gh repo view` is called once per run, and `mcp` runs again only after the `mcp` or `deps` fix. When no fix was attempted, no check runs twice. The `doctor --fix --json` output, each check's verdict and `fixesApplied` are unchanged.
