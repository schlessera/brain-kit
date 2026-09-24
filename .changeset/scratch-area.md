---
"@schlessera/brain": minor
"@schlessera/brain-module-images": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": minor
---

Transient output now has a place inside the brain: the scratch area, `.brain/scratch/`. `brain render --scratch` and `brain image --scratch` write there, under a name unique to each run, and so does `brain render -` without `--out`. The chat UI can open anything written there, it is never committed, indexed or exported, and it is pruned after 7 days or past 1 GB (after each of these writes, by `brain maintain`, hourly by the chat server, and by the new `brain scratch clean|prune`). Nothing writes there until git excludes the directory itself (`brain doctor --fix` adds the line, new brains have it from the template, and outside a git repository the line is required all the same, read by git), nothing is written to or pruned from a `.brain` or `.brain/scratch` that is a symlink, and every write goes to a temporary sibling renamed onto its name, so it never writes through a planted link. That covers every one of brain's own transient writers, wherever it is pointed: `brain render --out`, `brain image --out`, `brain okf export --out`, and a mask requested beside a draft in scratch, which now prunes like the others.

Behaviour change: `brain render` and `brain image` no longer accept paths under the system temp directory. A file there could not be opened from the UI. Use `--scratch` instead. `resolveWritable` now returns the path or `null`.
