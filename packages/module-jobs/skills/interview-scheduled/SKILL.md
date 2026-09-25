---
name: interview-scheduled
description: Use when an interview, screening, or evaluation call is booked, rebooked, or confirmed for an opportunity already being tracked — so the date reaches every place that would otherwise miss it.
---

# Interview Scheduled

A booked interview touches four places. Doing three of them leaves the summary
layer lying about where things stand, which is exactly when a date gets missed.
This skill does all four in one pass.

Find the opportunity directory before anything else. Run
`brain config check --json` and read `taxonomy.types.opportunity.dir`: it is
the jobs module's `opportunitiesDir`, which is `career/opportunities` by
default. Every path below writes it as `{opportunities}`.

## Prompts

1. **Company** — which opportunity? It must already exist.
2. **Date and time** — including the timezone.
3. **Round and format** — screening, technical, hiring manager, evaluation
   call. Duration if known.
4. **Interviewer** — name, role, contact details, as much as is known.

Ask for anything missing before writing.

## Actions

1. **Locate the opportunity** at `{opportunities}/{company-slug}/`.
   If it does not exist, stop and suggest `/research-opportunity` first — this
   skill records interviews for tracked opportunities, it does not create them.

2. **Update `{opportunities}/{company-slug}/status.md`**
   - Add a Timeline entry: today's date, the round, the interview date and time
     with timezone, the interviewer.
   - Set the Overview **Status** to `interviewing`.
   - Add or update the interviewer's row in the Contacts table.
   - Set frontmatter `deadline:` to the interview date.
   - Bump `updated`.

3. **Update the pipeline index** (`{opportunities}/_index.md`)
   - Put the concrete date in the row's Status, e.g.
     `interviewing — {round} Tue 7 Jul 15:30 CEST ({interviewer})`.
   - Update the row's Updated column and the file's frontmatter `updated`.

4. **Update the canonical current-focus document** (the taxonomy's
   `currentFocus`, e.g. `context/current-focus.md`)
   - Replace any "awaiting next steps" or "waiting to hear back" wording for
     this opportunity with the concrete date and time plus a wiki-link to the
     opportunity.
   - Keep the file short — push detail down into the opportunity files rather
     than letting the focus doc grow.
   - Bump `updated`.

5. **Create or update `{opportunities}/{company-slug}/interview-prep.md`**
   - If it exists: update the call details, set `deadline:` to the interview
     date, bump `updated`.
   - If not, create it:
     ```yaml
     type: opportunity
     title: "{Company} — {Round} Prep ({Interviewer}, {D Mon})"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [job-search, opportunity, {company-slug}, interview-prep]
     relevance: primary
     status: active
     deadline: {interview date}
     summary: "{One line: what the call is, when, with whom}"
     ```
   - Minimum content: a "The call" section (when, format, interviewer, what is
     being evaluated) and a Related section wiki-linking the opportunity's
     `status` and `research` docs.
   - Add the prep file to the status doc's Related Files section.

6. **Offer to draft prep content.** If `research.md` exists, offer to build the
   prep file out: the positioning angle, two or three project stories mapped to
   the role's requirements, likely questions, logistics, and watch-outs.
   Interviewer research only if asked; mark anything unconfirmed as
   `[VERIFY: ...]`.

## References

### Files to read
- `{opportunities}/{company-slug}/status.md` — current state, timeline,
  contacts
- `{opportunities}/{company-slug}/research.md` — prep source material, if
  it exists

### Files to write or modify
- Modify: `{opportunities}/{company-slug}/status.md`
- Modify: `{opportunities}/_index.md`
- Modify: the canonical current-focus document
- Create or modify: `{opportunities}/{company-slug}/interview-prep.md`

### Workflow position
- **Before**: `/research-opportunity` — the opportunity must already be tracked
- **After**: a prep session before the call; record outcomes afterwards

## Notes

- The `deadline` frontmatter on both the status and the prep file is what makes
  the interview surface in `brain briefing` and deadline queries. Never skip
  it.
- Always write timezone-explicit times. Calendar ambiguity causes rebookings.
- Rebooked interviews go through the same flow: a new Timeline entry (keep the
  old one), an updated deadline, an updated index row.
- Do not invent interviewer details. Record what the user provides, or clearly
  sourced research marked `[VERIFY]`.
