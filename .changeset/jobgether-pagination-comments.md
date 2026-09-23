---
"@schlessera/brain-module-jobs": patch
---

No behaviour change. The jobgether adapter's comments no longer say it is
capped at ten rows or that the endpoint can only page by query string. The
page size is the server's, and a POST body can page too, which is the route the
scraping-politeness decision rules out.
