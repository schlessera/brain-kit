---
"@schlessera/brain-module-jobs": patch
---

`jobs scrape jobgether` and `jobs scrape remotelyde` store job postings again.

Both boards reported rows that were not jobs. `jobgether` fetched five
`/remote-jobs/<location>/<category>` pages that answer HTTP 410; it now reads
the JSON endpoint the site's `robots.txt` points a crawler at, in one request
with no query string, and every row carries a title, a company and an ISO
posting date. `remotelyde` fell back to scanning `href="/remote-jobs/<slug>"`,
which is the site's own category navigation, so every stored row was a
navigation link with the company `Unknown`; it now parses the `/job/<slug>`
cards, from `www` and `/remote-jobs/seite/<n>` rather than from the apex and a
`?page=` query that both redirect. A card whose company or title cannot be read
is dropped with an error naming the field, instead of being stored as
`Unknown`.
