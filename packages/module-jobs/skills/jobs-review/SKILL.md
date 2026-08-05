---
name: jobs-review
description: Reviews the scraped job queue conversationally — surfaces top-scored pending jobs with their score breakdowns, hands promising roles to /research-opportunity, dismisses the rest. Use to review scraped jobs, check the queue, or triage job-board findings.
---

# Jobs Review

Conversational wrapper around the job pipeline's review queue. Keep it thin:
`brain jobs triage` is the interactive TUI for one-at-a-time triage, and this
skill is for reviewing in dialogue and feeding the winners into the opportunity
tracker.

## Prompts

None required. Optionally a minimum score or a source filter.

## Actions

1. **Check the database exists** — `jobs.db` at the brain root (or wherever
   `dbPath` points).
   - If it is missing, the scraper has not run in this checkout. Scheduled
     scrapes usually run on a hosting container, so local clones often have no
     `jobs.db` at all. Explain that, and offer the manual commands — but do
     **not** run a scraper unprompted: they hit external sites, may need a
     proxy, and some boards' terms of service restrict automated access.
     ```sh
     brain jobs scrape --all       # every API/RSS board
     brain jobs scrape --browser   # the headless-Chrome boards
     ```
     The two modes are separate runs.

2. **Confirm command ground truth** — run `brain jobs --help` and treat its
   output as authoritative. Documentation lags CLIs.

3. **List the queue** (read-only):
   ```sh
   brain jobs review --limit 20      # queued jobs, default sort
   brain jobs review --min-score 50  # tighten when the queue is long
   brain jobs stats                  # queue size and adapter health
   ```

4. **Present the top jobs** — a compact list: id, title, company, source,
   score. For the strongest candidates pull detail with `brain jobs show <id>`
   and explain the score breakdown, whose keys come from the scoring group
   names in the criteria file. Lead with the best fits; group the obvious noise
   separately.

5. **For roles worth pursuing**:
   - Mark it: `brain jobs decide <id> interested --notes "..."`
   - Hand off to `/research-opportunity` with the URL or description for full
     research, a fit assessment, and opportunity intake.
   - Lighter alternative when no deep research is wanted:
     `brain jobs scaffold <id>` creates the opportunity `status.md` directly
     and marks the job interested — but the pipeline row in
     `_index.md` still needs adding by hand.

6. **Dismiss the rest** — `brain jobs decide <id> dismissed` for jobs that were
   actually looked at and declined. Leave unreviewed jobs alone.

## References

### Data source
- `jobs.db` (gitignored; separate from `brain.db`)
- `brain jobs` — `review`, `show`, `decide`, `search`, `stats`, `scaffold`,
  `triage`
- The `@schlessera/brain-module-jobs` README — full command reference and
  architecture (verify against `--help`)

### Files to read
- The criteria file named by the module's `criteria` config — what the scores
  mean, when discussing fit

### Files to write or modify
- None directly. Job statuses change through the CLI; opportunity files are
  created by `/research-opportunity` or by `scaffold`.

### Workflow position
- **Before**: scrapes populate the queue
- **After**: `/research-opportunity` for pursued roles, then the pipeline in
  the opportunities index

## Notes

- Review statuses: pending, queued, interested, starred, dismissed, archived,
  applied.
- Never mass-dismiss without the user seeing the jobs. The queue is their call;
  the skill just makes it fast.
- Scores are heuristics over the criteria file's keyword lists. A mediocre
  score with a strong company or an unusual role angle is still worth
  surfacing — and a score that keeps being wrong in the same direction is a
  signal to retune the `scoring:` block, not to ignore the queue.
- `gc` and `score --rescore` are maintenance commands, not part of a review
  session.
