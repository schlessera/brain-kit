---
"@schlessera/brain": minor
"@schlessera/brain-common": minor
"@schlessera/brain-ui-server": minor
---

Apify runs of a robots-authorized profile now check every target against its site's robots.txt before the start request (#3330). `@schlessera/brain` gains a dependency on `@schlessera/brain-scrape` and builds the one checker that a standalone `brain apify` or `brain mcp` process and the hosted server share. The checker uses the scrape package's robots cache, its User-Agent and its public-only address policy: a `Disallow` refuses the run as `policy_denied` (`robots_disallowed`), with nothing started, and a missing or unreachable robots.txt means no rules, as for every scraping client. The hosted server loads the checker through its optional `@schlessera/brain` peer when the first such run arrives. A server installed without core still refuses those runs, as `site_permission_unproven`. No Actor build is qualified to run yet.
