---
name: interview-scheduled
description: Use when an interview, screening, or evaluation call is booked, rebooked, or confirmed for an opportunity already being tracked — so the date reaches every place that would otherwise miss it.
---

# Interview Scheduled

A booked interview touches four places. Doing three of them leaves the summary
layer lying about where things stand, which is exactly when a date gets missed.
This skill does all four in one pass.

Find the opportunity directory before anything else, the way
`brain jobs scaffold` does:

1. Run `brain config check --json`. If it reports `"valid": false`, stop and
   point the user at `brain validate`. Otherwise read
   `taxonomy.types.opportunity.dir`, and use it when it is a string.
2. When it is `null`, the taxonomy leaves the directory to the module. Run
   `brain config get modules.@schlessera/brain-module-jobs`. If that prints
   `null`, the jobs module is not enabled: stop, there is nowhere to write.
   Otherwise use its `opportunitiesDir`, which is `career/opportunities` by
   default when the block does not set it.

Every path below writes the directory you resolved as `{opportunities}`.

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
   - Add or update the interviewer's row in the Contacts table.
   - Set the frontmatter fields: `stage: interviewing`,
     `next_step: "{Round} with {interviewer}, {D Mon HH:MM TZ}"` and
     `deadline:` the interview date.
   - Bump `updated`.

3. **Refresh the pipeline index** — run `brain jobs pipeline`. Its tables are
   generated from the opportunities' frontmatter, so the new stage, next step
   and date show there; never edit a table row by hand.

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
     tags: [job-search, interview-prep]
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
- Run: `brain jobs pipeline`, which regenerates `{opportunities}/_index.md`
- Modify: the canonical current-focus document
- Create or modify: `{opportunities}/{company-slug}/interview-prep.md`

### Workflow position
- **Before**: `/research-opportunity` — the opportunity must already be tracked
- **After**: a prep session before the call; record the outcome afterwards in
  `status.md`'s fields: the next round's `next_step` and `deadline`, or
  `stage: offer`, then `brain jobs pipeline`. To close instead, follow
  `/research-opportunity`'s **Closing** steps: they remove `next_step` and
  `deadline` from `status.md` and this prep file's `deadline`, keeping both as
  history, so a cancelled interview stops showing in `brain briefing`

## Notes

- The `deadline` frontmatter on both the status and the prep file is what makes
  the interview surface in `brain briefing` and deadline queries. Never skip
  it.
- Always write timezone-explicit times. Calendar ambiguity causes rebookings.
- Rebooked interviews go through the same flow: a new Timeline entry (keep the
  old one), an updated `next_step` and `deadline`, and `brain jobs pipeline`.
- Do not invent interviewer details. Record what the user provides, or clearly
  sourced research marked `[VERIFY]`.
