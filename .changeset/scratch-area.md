---
"@schlessera/brain": minor
"@schlessera/brain-module-images": minor
"@schlessera/brain-ui-sdk": patch
---

Transient output now has a place inside the brain: the scratch area, `.brain/scratch/`. `brain render --scratch` and `brain image --scratch` write there, and so does `brain render -` without `--out`. The chat UI can open anything written there, it is never committed, indexed or exported, and it is pruned after 7 days or past 1 GB (on every write into it, by `brain maintain`, and by the new `brain scratch clean|prune`). Nothing writes there until it is gitignored; `brain doctor --fix` adds the line, and new brains have it from the template.

Behaviour change: `brain render` and `brain image` no longer accept paths under the system temp directory. A file there could not be opened from the UI. Use `--scratch` instead. `resolveWritable` now returns the path or `null`.
