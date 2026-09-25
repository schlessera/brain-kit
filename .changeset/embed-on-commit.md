---
"@schlessera/brain": minor
---

A brain can opt in to embedding each commit's changes in the background. With the new config key `hooks.embedOnCommit: true` and an embedding provider configured, the post-commit hook's background index run also embeds the chunks the commit changed. Vector and hybrid search then see an edit without waiting for `brain maintain` or `brain sync`. The option is off by default, so a commit never makes a paid call unless the brain asks for it. The hook now runs `brain index --incremental --quiet --on-commit`, and the new `--on-commit` flag makes the decision in the CLI. The sidecar cache lines such a run adds are committed by `brain sync`, not by the hook. Run `brain setup` to install the updated hook in an existing brain.
