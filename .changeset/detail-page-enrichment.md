---
"@schlessera/brain-module-jobs": minor
---

`jobs scrape` follows a job with no description to its own page on the board
and takes the description from that page's `JobPosting` structured data. This
covers `nodesk`, `simplyhired`, `dice`, `remotelyde` and `jobgether`. `builtin`
now reads its descriptions from its own listing's structured data. A row that
already has a description, from the feed or an earlier run, is not fetched.
Detail requests go through the run's shared client, so robots.txt and per-host
pacing apply, with at least 2 s between requests to one host. The new
`enrichment` config (`concurrency`, default 4; `maxDetailPages`, default 100,
`0` = off) bounds them. Each board's row in the `--json` report gains
`jobs_enriched`, `enrichment_failed` and `enrichment_truncated`, and each
non-zero count has a line in `errors`. A failed detail page never costs the
row.
