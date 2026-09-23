---
"@schlessera/brain": minor
---

`brain stats` reports health and size, not just row counts.

`--json` grows two nested blocks and loses nothing: every field a consumer
already reads keeps its name, and its type, except `embeddings`, which becomes
`number | null` in the same release (see its breaking-change note).

`health` answers "what needs attention": the broken-link **rate** over the
link count, embedding coverage as vectors over chunks, and the stale, orphan
and untagged document counts. Stale and orphan are not new definitions — they
are the ones `brain audit` already reports, read from the same per-type
`staleDays` and `orphanExempt`, so the two commands cannot drift. `health`
also echoes the warn levels in force, so a consumer never duplicates the
defaults.

`size` answers "what does this brain weigh": corpus bytes and file count on
disk with the configured excludes applied, `brain.db` bytes with its per-table
row counts, and free space on the volume. The index size is a rebuild-cost
figure; `brain.db` stays disposable.

A figure that cannot be measured is reported as `null`, never as `0` — an
unknown embedding coverage must not read as a failing one, and a platform
without a usable free-space call does not fail the command.

New optional `stats` config block for the warn levels: `coverageFloor`
(default `0.9`) and `brokenLinkCeiling` (default `0.05`), both ratios in
`0..1`.
