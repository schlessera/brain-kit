---
"@schlessera/brain-module-jobs": minor
---

`jobs scrape` follows a job with no description to its own page on the board
(`source_url`, never the apply link) and takes the description from that page's
`JobPosting` structured data. This covers `nodesk`, `simplyhired`, `dice`,
`remotelyde` and `jobgether`. `builtin` now reads its descriptions from its own
listing's structured data. A row that already has a description, from the feed
or an earlier run, is not fetched, and two rows for one posting cost one
request. Detail requests go through the run's shared client and the run's
`--proxy`, so robots.txt and per-host pacing apply, with a 2 s floor between
detail requests to one host (retries and redirects are not paced separately;
see #259). The new `enrichment` config (`concurrency`, default 4;
`maxDetailPages`, default 100, `0` = off) bounds them, and the cap is shared
round-robin across boards. Each board's row in the `--json` report gains
`jobs_enriched`, `enrichment_failed` and `enrichment_truncated`, and a non-zero
failed or truncated count also has a line in `errors`. A failed detail page never
costs the row. A stored row that gains a description is scored again, and an
automatic queue or dismiss decision on it is reconsidered. A decision a person
made is kept.
