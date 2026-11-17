---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Media awaiting a decision is now one inventory that `brain sync` counts and hygiene review selects from (#2780). The routine `brain sync` report no longer lists media paths: it prints one line, `Media awaiting review: N`, with what is set aside and kept as a copy when there is any and `· review in Actions` while anything awaits review. A report without media is unchanged. Bare `brain sync` no longer hands media to the agent at a terminal. `run.leftovers.media` keeps its paths, and `run.leftovers` gains `mediaPending` and `mediaSetAside: { dismissed, snoozed, kept }`.

`brain hygiene` detects each uncommitted MEDIA or LARGE file as a finding of category `media`: MEDIA is informational, LARGE a warning, and both on one file are one finding. Media findings are always shown in review. Files a conversation linked under `.brain/scratch/` (read from the scratch pin snapshot, at most 5,000 paths unless `BRAIN_MEDIA_PINNED_PATH_LIMIT` says otherwise) are review-only findings, even when `media.ignore` matches them. They never change the count, and the scratch area is never walked. Files `media.ignore` matches outside scratch stay out.

A fifth log state, `kept`, lives in `context/hygiene/kept.md`. The new `brain hygiene keep-copy <id> --expect-fingerprint <fp> --copy <path> --copy-sha256 <sha256> --journal <id>` records it, and only for a copy that already holds. The file is written only once it holds an entry, so existing hygiene files stay byte-identical. A kept original holds while its copy exists outside `.brain/` and `workspaces/` and `media.track` keeps it. Otherwise it opens again with a `changed: copy-missing`, `copy-untracked`, `kept-incomplete` or fingerprint receipt.

The JSON envelopes gain keys and remove, rename or retype none. Each new key comes after every existing one:

- `brain hygiene list` entries gain `copy`, `copySha256` and `keptOn` (always present, `null` unless kept). The `kept` state, disposition kind and invalidation disposition are new values that never appear without a kept entry; a consumer that switches on them exhaustively must handle `kept`.
- `brain hygiene reconcile` gains `kept`.
- `brain hygiene next` gains `counts.kept` and `media: { awaitingReview, setAside, kept, links }`, and accepts `--defer <id>=<fp>,...`.

Review's Leave pending (a `defer` effect with a `deferred` outcome) skips a media finding for the rest of the pass while its fingerprint holds. The finding still counts as awaiting review, and a new pass selects it again. The review state gains `kept`, `pass`, `deferred`, `media` and `counts.kept`; a stored row without them reads as `0` or `[]`.
