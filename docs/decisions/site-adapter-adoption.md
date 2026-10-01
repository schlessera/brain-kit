# Adopt one site-adapter lifecycle and runner

The [maintainer's 2026-09-28 ruling on #344](https://github.com/schlessera/brain-kit/issues/344#issuecomment-5866304745)
selects adoption: evolve the existing `SiteAdapter` around demonstrated board
requirements and move all ten jobs boards onto its shared runner before 1.0.
The seam stays experimental until then. The ruling preserves jobs CLI outcomes,
positive-empty evidence, cursor/query inputs, transport availability, politeness
and detail-page restrictions; it does not authorize a new execution framework,
board-selection policy or immediate interface freeze.

## Why adoption needs an outcome

The old generic result carried items, a cursor and errors. Jobs already needed
to distinguish a board with no postings from unreadable or changed pages. The
count is not evidence: a recognized API's empty record list and a maintenance
page whose renamed fields yield nothing both produce zero rows. An empty
array alone cannot mean a healthy empty source.

The generic result now carries the same four states
(`AdapterStatus`, `packages/scrape/src/adapter/types.ts:64-79`). `ok` may have
partial rows and diagnostics. `empty` requires positive evidence from readable
pages; readable but unrecognized pages are `unparseable`, and no readable result
is `not_run`. `ok([])` reports a diagnostic parse failure rather than inventing
empty-state evidence. An adapter with its site's actual empty signal returns
that explicit outcome. `partial([], error)` describes an unavailable result,
not a verified empty page.

Jobs keeps its concrete evidence ledger
(`PageLedger`, `packages/module-jobs/src/adapters/base.ts:90-177`). Its checks
are unchanged: every attempted page must be readable and recognized before a
zero can be `empty`; a failed page denies that state; a pagination continuation
counts only after an earlier page actually parsed; a redirect to another site
is diagnostic even when rows came out. No generic code imports jobs, its raw
posting shape, source registry, tiers, persistence or scoring.

## One execution boundary, domain composition

`JobAdapter` is a composition of the existing generic interface
(`JobAdapter`, `packages/module-jobs/src/types.ts:89-97`), adding source, tier,
detail-host allowlists and detail-fetch options. It adds no lifecycle, registry
or plugin loader. All real boards inherit the shared `scrape(ctx, options)`
entry through their concrete jobs base; context belongs to one call and is
released afterward. Their parser/page methods are ordinary implementation.

Production calls the shared runner
(`const outcomes = await runAdapters`, `packages/module-jobs/src/scrape.ts:156-173`).
The competing bind/parallel-execution path is removed. The existing sequential
runner executes in selection order; this migration adds no concurrency policy
or new scheduling knob. Jobs still collects every listing before its fair,
bounded enrichment phase, then ingests, deduplicates and scores. Each selected
source keeps its CLI row, even when its transport or execution failed.

The runner owns browser admission, source isolation and browser cleanup
(`runAdapters`, `packages/scrape/src/adapter/runner.ts:46-106`). It supplies one
HTTP client and browser context only to requesting adapters. Missing required
browser/proxy, thrown run options or an adapter exception becomes that source's
`not_run` outcome; later sources still run. A constructed browser shares the
HTTP client's robots cache, limiter and User-Agent unless explicit browser
options replace them. It closes in `finally`; a preconstructed session stays
caller-owned. Jobs closes its database on success and exceptional exits.
The [browser navigation policy](scraping-politeness.md#browser-enforcement-ruling)
remains binding, including its deliberate subresource boundary.

Cursor and query inputs use the generic options directly. HTTP boards forward
per-run fetch overrides with their board options, merged headers and proxy;
an explicit board delay remains a floor even when a run asks for a shorter one.
Query-driven boards prefer nonempty run queries over constructor defaults.
Job-specific detail metadata still passes to the existing enricher, which
follows only allowed board hosts and preserves proxy, pacing, caps and errors.
No apply-host permission or new robots opt-out is inferred from the migration.

## Evidence and compatibility

The fixture conformance suite executes every registered real board through
`runAdapters`: real HTTP parsers and real browser extraction functions over a
DOM, sealed transports, nonempty output assertions, positive-empty and drift
cases, unavailable prerequisites, cursor/query/fetch propagation and caller
ownership. A production probe observes the actual `runAdapters` call and both
failed and successful sources. Production enrichment checks allowed requests
and persisted descriptions, while real Chrome tests exercise robots refusal
and shared pacing through the same orchestration. These are execution checks,
not interface predicates or authentication-only assertions.

Before migration the conformance cases fail on actual outcomes and the
production runner-call assertion sees zero calls. Mutating ledger evidence,
transport admission, enrichment host metadata or cleanup must break the named
runtime assertions. The public API reports record the generic interface,
runner/helpers and jobs composition with their reachable types.

This is the approved pre-1.0 break under #344, implemented by #545 with a
breaking minor changeset. `AdapterResult.status` is required. Jobs replaces
`ScraperAdapter` with `JobAdapter`, removes its duplicate `ScrapeResult`, and
uses generic `AdapterResult<RawJob>`. Consumers replace `bind(ctx).scrape(opts)`
with `scrape(ctx, options)`, `lastCursor` with `cursor`, and result `jobs` with
`items`; source identity comes from the adapter or runner outcome. The
[package migration guide](../../packages/scrape/README.md#pre-10-migration) and
[integration contract](../integration-contract.md#siteadapter-conformance-and-migration)
carry these changes. CLI `{ report }`, source diagnostics and cursor persistence
rules are preserved. #534 consumes this implemented boundary when curating
final exports; this decision does not freeze other ordinary exports.

## Alternatives rejected

- **Freeze the unused generic shape.** It would erase jobs' outcome evidence
  or require a competing wrapper protocol; callers could read parser drift as
  a healthy empty board.
- **Delete the generic seam and keep the jobs lifecycle.** The observed second
  scraper shows why the shared seam exists. The maintainer selected adoption
  rather than retreating to domain-specific infrastructure.
- **Keep bind plus a second runner.** Sharing HTTP classes alone does not make
  resource admission and cleanup one boundary; the two paths can still drift.
- **Move all jobs metadata into brain-scrape.** Sources, tiers, scoring and
  persistence describe one domain. Concrete composition preserves them without
  making a generic adapter depend on that domain.
- **Add a plugin loader, parallel scheduler or new browser policy.** None is
  needed to adopt the existing runner. The selected scope is one lifecycle,
  evidence-preserving results and existing transport/politeness behavior.
