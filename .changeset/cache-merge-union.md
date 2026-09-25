---
"@schlessera/brain": patch
---

The sidecar caches now merge in any git merge, not only in `brain sync pull`. The template ships a `.gitattributes` that gives `.context-cache.jsonl` and `.asset-cache.jsonl` git's built-in `merge=union` driver, so a plain `git pull`, a rebase or a hosting container's merge keeps both sides' lines instead of conflicting. The order that leaves does not matter to a reader, and the file is sorted again the next time an index run adds or prunes a line. `brain doctor` has a new `cache-merge` check that warns when either file lacks the attribute, and `brain doctor --fix` appends the lines to the brain's `.gitattributes`.
