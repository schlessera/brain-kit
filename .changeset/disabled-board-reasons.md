---
"@schlessera/brain-module-jobs": patch
---

The reasons recorded for the jobs boards that are off by default no longer say "Cloudflare 403 or empty responses" for three boards where that is no longer true. `builtin` now gives the browser reason `nodesk` and `dice` give, `simplyhired` names the intermittent rate limiting that was measured, and `jobgether` names the robots.txt rule that limits a run to one page.
