---
"@schlessera/brain-scrape": minor
"@schlessera/brain-module-jobs": minor
---

Approved pre-1.0 breaking SiteAdapter migration (#344/#545): AdapterResult now
requires an evidence-derived status (ok, empty, unparseable or not_run).
ok([]) reports diagnostic unparseable rather than implying confirmed empty.
All ten jobs boards now implement the shared SiteAdapter and execute through
runAdapters in selection order, with owned-browser cleanup and isolated source
failures. The jobs CLI report/status/cursor semantics remain unchanged.

Embedding migration: replace jobs ScraperAdapter with JobAdapter and jobs
ScrapeResult with brain-scrape AdapterResult<RawJob>; replace
bind(ctx).scrape(opts) with scrape(ctx, options), lastCursor with cursor and
result.jobs with result.items. Source identity comes from the adapter's
id/source or the runner outcome's id. Job-specific metadata, PageLedger,
enrichment, persistence and scoring remain in module-jobs.
