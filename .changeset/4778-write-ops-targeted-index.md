---
"@schlessera/brain": patch
---

`brain_update`, `brain_archive`, `brain_add`, `brain add` and `brain archive` now index only the files they changed instead of re-reading the whole brain (#4778): the document written, and both its old and new paths when an archive moves it. The rest of the brain is taken from the index, so a write costs one file's parse rather than one full read of every note. **Behaviour change:** a write no longer picks up markdown files edited outside the tool since the last complete index run. Those files stay unindexed until the next complete run (`brain index`, `brain sync` or a git hook), and the read tools keep reporting them in their stale-index warning. Tool names, schemas and results, and the `--json` output of `brain add` and `brain archive`, are unchanged.
