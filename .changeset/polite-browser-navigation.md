---
"@schlessera/brain-scrape": minor
"@schlessera/brain-module-jobs": minor
---

BREAKING before 1.0: browser loads now enforce robots.txt and Crawl-delay on main-frame navigation, including redirects, and use the package User-Agent by default. Share HTTP/browser policy state per run, add an origin-scoped per-call permission override, and include policy waits in the page budget while preserving jobs JSON/status shapes.
