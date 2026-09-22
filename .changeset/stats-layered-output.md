---
"@schlessera/brain": minor
---

`brain stats` reads as an answer rather than a dump. The human output now
leads with a **Health** section — broken-link rate, embedding coverage, stale,
orphans, untagged — each line naming the level that judged it, above an
**Inventory** section holding the counts and what the brain weighs on disk.

Every breakdown is ranked by count and capped at the top five, followed by a
`+N more (M documents)` remainder, so a corpus with forty types no longer
prints forty lines three times over. `brain stats --all` expands every
breakdown.

`--all` is a human-output flag only: `--json` is unchanged and always carries
the full, uncapped breakdowns, so `brain stats --json` and
`brain stats --all --json` produce the same object.

Also in the human output: byte counts scale to KB/MB/GB instead of always
printing MB (a 22 KB corpus used to read as `0.0 MB`), and a brain with no
documents prints one line naming the next step instead of a page of empty
headings.
