---
"@schlessera/brain": patch
---

`brain doctor --fix` re-runs two more checks after the fixes that can change them (#4885). The `mcp` check runs again after the `symlinks` fix, which can restore the skill or bin link a `.mcp.json` registration's script is reached through. The `git-storage`, `tracked-leftovers` and `tracked-media` checks run again after the `deps` fix, whose `bun install` runs the brain's own lifecycle scripts, which can write git objects or stage files. In both cases `doctor --fix` printed a first-pass result that a plain `brain doctor` straight afterwards contradicted. Verdicts, texts, the order of `checks` and the `--json` shape are unchanged.
