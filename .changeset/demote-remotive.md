---
"@schlessera/brain-module-jobs": minor
---

`remotive` is no longer enabled by default. Its `robots.txt` disallows `/api/*`,
the only path the adapter fetches, so every run ended in five refused requests.
The adapter stays, and `jobs scrape remotive` or a `boards` entry still selects
it, but it can only succeed with the site's permission.
