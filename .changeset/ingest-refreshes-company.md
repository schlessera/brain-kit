---
"@schlessera/brain-module-jobs": minor
---

Re-scraping a stored job now refreshes its `source_url` and `company`, so an
adapter repair reaches rows stored before it. A changed company or title
recomputes `company_normalized`, `title_normalized` and `fingerprint`, and
rebuilds the job's full-text row. An incoming `Unknown` company never replaces
a real one. When a row's fingerprint changes, it leaves its dedup group: it
stops being marked as a duplicate, the rows marked as duplicates of it are
released, and the dedup pass after the scrape regroups them.
