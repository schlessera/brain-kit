# @schlessera/brain-module-jobs

A brain-kit module that runs a personal **job-search pipeline**: it scrapes
remote-job boards, deduplicates and full-text-indexes the postings in its own
SQLite database, scores each one against criteria you define, and gives you a
CLI (`brain jobs …`) to triage the results and scaffold opportunity notes into
your brain.

## Install / enable

Add it to `brain.config.ts`:

```ts
export default defineConfig({
  modules: {
    "@schlessera/brain-module-jobs": {
      criteria: "career/opportunities/search-criteria.md",
      opportunitiesDir: "career/opportunities",
      boards: ["remoteok", "remotive", "weworkremotely"],
      // queries: ["staff engineer", "platform engineer"],  // for query-driven boards
      // dbPath: "jobs.db",                                   // default: <root>/jobs.db
    },
  },
});
```

## Contributed taxonomy type

| Type          | Default dir            | Index anchor |
| ------------- | ---------------------- | ------------ |
| `opportunity` | `career/opportunities` | `status.md`  |

`brain jobs scaffold <id>` creates `career/opportunities/<company-slug>/status.md`
for a job you're interested in, and marks the job `interested` in the jobs DB.

> **Relocating the dir.** Set `opportunitiesDir` in the module's config block —
> the manifest's `setup()` derives the `opportunity` taxonomy dir from it, so
> the CLI's write target and path→type inference move together. No separate
> taxonomy override needed.

### Index-sync rule

The module contributes the dir anchor `status.md`, so a wiki-link to an
opportunity directory (`[[career/opportunities/acme]]`) resolves to that dir's
`status.md`.

### Cron

Advisory schedule (consumed by container entrypoints / `brain doctor`):
`scrape` daily at 06:00 — `jobs scrape --all --browser`, i.e. one run covering
every board including the ones that need Chrome. A host without a usable
browser loses those boards rather than the whole scrape.

## The scoring criteria file

Scoring is **not** hard-coded. It is driven by the YAML frontmatter of the
markdown file named by `criteria` (which stays brain content you own and tune).
Copy [`docs/criteria-template.md`](./docs/criteria-template.md) to that path and
edit the `scoring:` block. Score breakdowns are keyed by **your** group names.

```yaml
scoring:
  groups:                       # each contributes up to `weight` points
    - name: distributed-systems # becomes a key in the score breakdown
      weight: 25
      match: all                # "all" (title+desc+tags+location, default) | "title"
      titleBoost: 1.2           # optional: multiply a tier's points on a title match
      tiers:                    # graded lists, strongest first; best match wins
        - points: 25
          keywords: [distributed systems, consensus]
        - points: 15
          keywords: [scalability, microservices]
    - name: seniority
      weight: 15
      match: title
      keywords: [staff, principal, lead]   # flat list => full weight on any match
  location:                     # word-boundary matched ("uk"/"eu" stay safe)
    weight: 20
    preferred: [remote, europe, worldwide] # any match => full weight
    excluded:  [us only, united states only] # any match => location scores 0
  excludeTitles: [sales, recruiter]        # title match => whole job scores 0
  compensationBenchmark: 15000000          # optional; EUR minor units (cents), annual
  compensationWeight: 10
  queueThreshold: 60            # score >= => queued for review
  dismissThreshold: 35          # score <  => auto-dismissed
```

Scoring algorithm: for each group, the best matching tier's points (clamped to
`weight`) are added; the location dimension adds its `weight` for a preferred
marker (or 0 if an excluded marker matches); the compensation dimension compares
`salary_max` (normalized to EUR cents on ingest) to the benchmark. An
`excludeTitles` hit zeroes the whole job. `total` is the sum of all dimensions.

## Config schema

| Key                | Type       | Default                                                     | Meaning                                      |
| ------------------ | ---------- | ----------------------------------------------------------- | -------------------------------------------- |
| `criteria`         | `string`   | *(required)*                                                | Path to the scoring criteria markdown file.  |
| `opportunitiesDir` | `string`   | `career/opportunities`                                      | Where `scaffold` writes opportunity dirs.    |
| `boards`           | `string[]` | `["remoteok"]`                                              | Boards scraped when no source is given.      |
| `queries`          | `string[]` | `["software engineer", "backend engineer", "platform …"]`   | Search terms for query-driven boards.        |
| `dbPath`           | `string?`  | `<root>/jobs.db`                                             | Jobs database location (gitignore it).       |

## CLI

```
brain jobs scrape [sources...]   # configured boards (--all for every API board,
                                 #   --browser to add the Chrome boards)
brain jobs score                 # score unscored jobs + classify (--rescore for all)
brain jobs triage                # interactive one-at-a-time review (TTY)
brain jobs review                # list the review queue
brain jobs stats                 # database + adapter-health stats
brain jobs scaffold <id>         # create an opportunity dir from a job
brain jobs show|open|decide|search|gc …
```

### Boards that need a browser

`builtin`, `nodesk` and `dice` are client-rendered, so they are scraped through
headless Chrome. They are ordinary sources: the adapter declares `needsBrowser`
and the runner supplies a browser when one of the selected boards wants it.
There is no second pass and no second pipeline — these two flags just select
sources.

| Invocation                        | Runs                                        |
| --------------------------------- | ------------------------------------------- |
| `brain jobs scrape`               | the configured boards                       |
| `brain jobs scrape --all`         | every board                                 |
| `brain jobs scrape --browser`     | the configured boards **plus** the browser ones |
| `brain jobs scrape --browser-only`| only the browser ones                       |

Chrome comes from `@schlessera/brain-scrape`, which launches and owns it — the
old requirement to start Chrome yourself on port 9222 is gone. Install the
optional peer `puppeteer-core` and have a Chrome or Chromium on the host; set
`SCRAPE_CHROME_PATH` if it is somewhere unusual, or `SCRAPE_CHROME_URL`
(or the legacy `CHROME_CDP_URL`) to attach to an instance you already run. With
no usable browser, those boards report it and every other board still lands.

Scraping goes through the shared client, so every board obeys `robots.txt`,
honours `Crawl-delay`, and identifies itself honestly. See
[@schlessera/brain-scrape](../scrape/README.md).

## Boards & sources

Full-feed / category boards (no browser, enabled by default): `remoteok`,
`remotive`, `weworkremotely`, `workingnomads`, `remotelyde`, `remoteineurope`.
Query-driven or JS-heavy boards (may need `--proxy` or `--browser`): `simplyhired`,
`jobgether`, `builtin`, `nodesk`, `dice`.

## ⚠️ Scraping & Terms of Service

This module fetches public job listings for **personal research**. Scraping may
violate a site's Terms of Service, and sites can rate-limit or block requests.
Before scraping a board:

- Review its **Terms of Service** and **`robots.txt`** and respect them.
- Keep request volume low; the built-in per-domain rate limiter is a courtesy,
  not a substitute for reading the ToS.
- Prefer official APIs/feeds where a board offers them.

**You are responsible for how you use these scrapers.** They are provided as-is,
with no warranty, for individual use.

## Environment

Every variable this package reads, and what happens when it is unset. This
table is generated from the package's env chokepoint — the single file allowed
to touch `process.env`.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `CHROME_CDP_URL` | Legacy alias for SCRAPE_CHROME_URL: the DevTools endpoint of an already-running Chrome used for browser-only boards. Kept so an existing deployment keeps working; SCRAPE_CHROME_URL wins when both are set. Unreachable or absent Chrome downgrades the browser boards and leaves the rest of the scrape alone. | — |

Generated from `packages/module-jobs/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->
