---
name: submission-outcome
description: Use when a decision on a submitted talk arrives — accepted, not selected, waitlisted, or held as backup — for any submission being tracked.
---

# Submission Outcome

Closes the "[Wait for acceptance]" gap in the conference workflow. One decision
email → all tracking layers updated in the same operation (Index Sync Principle).

## Prompts

1. **Conference**: Which conference + year? (must exist as `conferences/{name}-{year}/`)
2. **Talk**: Which submission? (there may be several `submission-{slug}.md` files)
3. **Outcome**: accepted / rejected (not selected) / waitlisted / backup
4. **Decision date** and any conditions: confirmation deadline, format change, slide deadline, speaker tasks

## Actions

1. **Locate and read** `conferences/{name}-{year}/status.md` and `submission-{slug}.md`.

2. **Update the conference `status.md`** (the tracking anchor — create it if the directory somehow lacks one):
   - Set the talk's **Status** field in its table (e.g. `Accepted`, `Not selected`)
   - Add Timeline rows: decision date, plus any new deadlines (confirmation, slides)
   - On acceptance with a hard deadline: set frontmatter `deadline:` to the nearest one
   - Bump `updated`

3. **Update the submission file** `submission-{slug}.md`:
   - Append the outcome to the frontmatter `summary` (e.g. "…— accepted 2026-03-25")
   - Bump `updated` (frontmatter `status` stays `active` while the conference is live)

4. **Update `conferences/_index.md`**:
   - Reflect the outcome in the conference's Status column (e.g. "1 accepted, 1 not selected — awaiting schedule")
   - Bump the index frontmatter `updated`

5. **Update `talks/_proposals.md`** (the outcome registry for all submissions):
   - Add or update the talk's row in the current year's table with the outcome
   - Bump `updated`

6. **On acceptance**:
   - Update the canonical current-focus doc (e.g. `context/current-focus.md`): add the accepted talk + conference dates to the relevant section (keep the file concise), bump `updated`
   - Suggest running `/talk-prep` to build presentation materials
   - Remind about travel: check `travel/_index.md` for an existing trip; if none, suggest `/plan-travel` (if the travel party includes companions or anyone with a `requirementsDoc`, logistics need lead time)

7. **On rejection**:
   - Record it; keep the conference files `status: active` until the CFP season is over or the conference has passed (other submissions or next steps may still be live)
   - Discuss resubmission: does the talk fit another conference in `conferences/_index.md`? If yes, note the resubmission target in the talk's `talks/_proposals.md` row or the submission file's Notes

## References

### Files to Read
- `conferences/{name}-{year}/status.md` (talk table, timeline)
- `conferences/{name}-{year}/submission-{slug}.md`
- `conferences/_index.md` (conference row)
- `talks/_proposals.md` (proposal registry format)

### Files to Write/Modify
- Modify: `conferences/{name}-{year}/status.md`
- Modify: `conferences/{name}-{year}/submission-{slug}.md`
- Modify: `conferences/_index.md`
- Modify: `talks/_proposals.md`
- Modify (acceptance only): the canonical current-focus doc (e.g. `context/current-focus.md`)

### Workflow Position
- **Before**: `/new-submission` (submission exists, decision pending)
- **After**: acceptance → `/talk-prep` + `/plan-travel`; delivery → `/conference-aftermath`

## Notes

- Status wording follows a stable convention: `Accepted`, `Not selected`, `Accepted → Withdrawn` — keep a talk's whole lifecycle visible in its `status.md` row
- A conference can have mixed outcomes across talks — the index row should summarize all of them, not just the latest decision
- Waitlist/backup outcomes are recorded the same way and revisited when the final decision lands (run this skill again)
- Archiving conference files happens later via `/conference-aftermath`, not here
