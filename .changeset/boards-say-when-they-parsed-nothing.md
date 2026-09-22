---
"@schlessera/brain-module-jobs": minor
"@schlessera/brain-scrape": minor
---

A job board that parses nothing says so, instead of reporting zero found and
zero errors.

`jobs scrape` now reports a **state** per board rather than only a count, in the
run summary and in the `--json` envelope's `sources[]` rows: `ok`, `empty`
(the board's own envelope, carrying no postings), `unparseable` (a page arrived,
did not say it was empty, and yielded nothing) or `not_run` (nothing readable
arrived at all). `empty` is the only zero-row state allowed to carry no errors, and an
adapter may only claim it from a positive signal — an API answering with its
envelope and an empty record list, a feed with a channel and no item markup
at all — so a
board with no way to prove its own empty state reports a served page it read
nothing off as drift.

Fed a page that is not its board's, every one of the eleven adapters now
reports; four of them returned in silence before. `remoteineurope`, whose
domain 301s to another job site and answers 200 there, is the one this was
named after: it reports an error per page, and names the site that served the
redirect. Every selected board keeps a row in the report, including one whose
adapter never returned, and `scrape_runs.status` follows — `unparseable` and
`not_run` are logged as `failed`, so a board that could not be read stops
advancing its cursor.

`@schlessera/brain-scrape` gains `ScrapeClient.getPage`, which returns a text
body alongside the URL it was actually served from. `getText` delegates to it
and is unchanged.
