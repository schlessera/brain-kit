---
name: research-opportunity
description: Use when a specific role turns up that deserves a proper look, given as a link or a pasted job description — to research the company, weigh it against the search criteria, and decide whether to pursue it.
---

# Research Opportunity

Turns a job listing into a tracked opportunity: extracted details, company
research, an honest fit assessment against your own criteria, and a
conversation about whether to pursue it.

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

1. **Job description**: a URL to the listing, or the full pasted text.
2. **Source** (optional): how you found it — a job board, a referral, direct
   outreach, the scraped queue.

## Actions

1. **Extract job details.**
   - Given a URL, fetch it. Many boards sit behind bot protection; if the fetch
     fails, ask for pasted text rather than retrying.
   - Extract: company name, role title, location and remote policy,
     responsibilities, requirements, nice-to-haves, compensation and benefits
     if listed, and the application URL or process.

2. **Derive a company slug** — kebab-case from the company name
   ("CloudLinux" → `cloudlinux`, "Weights & Biases" → `weights-and-biases`).

3. **Check for an existing opportunity.** If
   `{opportunities}/{company-slug}/` already exists, ask whether to update
   it or stop.

4. **Research the company.** What they build, products, size and stage,
   funding, tech stack, recent news, culture signals, and the people who would
   be in the loop (engineering leadership, the likely hiring manager). Depth
   depends on what is publicly available — do not force it when there is
   little to find.

5. **Read the context you need to judge fit.**
   - The criteria file named by the jobs module's `criteria` config (for
     example `{opportunities}/search-criteria.md`) — must-haves, strong
     preferences, dealbreakers. Its `scoring:` frontmatter is what
     `brain jobs score` uses; the prose below it is what *you* use.
   - Your identity/positioning doc (the taxonomy's canonical `identity`, e.g.
     `me/identity.md`).
   - Your expertise index, if you keep one, for honest depth levels.

6. **Assess fit.** Walk the criteria file explicitly:
   - Each must-have: met, not met, or unclear.
   - Strong preferences: which ones this role hits.
   - Dealbreakers: any triggered.
   - Alignment: where your experience maps directly onto the requirements.
   - Gaps: requirements you do not fully meet. Be candid — a fit assessment
     that flatters is worthless three weeks later in an interview.
   - If you maintain more than one CV variant, suggest which one fits.

7. **Create the opportunity directory and `status.md`.**
   - Path: `{opportunities}/{company-slug}/status.md`
   - Frontmatter:
     ```yaml
     type: opportunity
     title: "{Company Name} — {Role Title}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [job-search]
     relevance: primary
     stage: researching
     fit: {strong | medium | weak}
     summary: "{Role Title} at {Company Name} — {one line}"
     ```
     Where it stands lives in these fields, not in prose (see Pipeline fields
     below). Add `next_step` and its date as `deadline` once there is one.
   - Sections:
     - **Overview** — company, role, location, source, listing URL
     - **Fit Assessment** — role fit, company fit, compensation range, key
       attraction, key concern, then Alignment and Gaps subsections
     - **Materials Sent** — empty table (Date | Material | Notes)
     - **Contacts** — empty table (Name | Role | Relationship | Notes)
     - **Timeline** — first entry is the date identified
     - **Notes** — initial observations
     - **Full Job Description** — the complete text, verbatim. Listings get
       taken down; this is the only copy you will have later.

8. **Create `research.md`** — only if the company research actually turned
   something up.
   - Path: `{opportunities}/{company-slug}/research.md`
   - Frontmatter mirrors `status.md` with `title: "{Company Name} — Research"`
     and `tags: [job-search]`, and no `stage` (only `status.md` carries one).
   - Sections: Company Overview, Why This Could Work, Concerns / Red Flags,
     Relevant Connections, Key People.
   - Skip the file entirely when research was thin. A stub is worse than
     nothing.

9. **Refresh the pipeline index** — run `brain jobs pipeline`. The index's
   tables are generated from every `status.md`'s frontmatter; never add or edit
   a table row by hand.

10. **Present the findings and talk it through.**
    - A concise summary: what aligns, what is a gap, any red flags.
    - A recommendation: pursue, skip, or needs more information.
    - If pursuing: which CV variant, positioning considerations, and whether to
      apply cold or find an internal contact first.
    - Then ask what they think. This is a conversation, not a report dump —
      the skill is not finished until they have weighed in.

## References

### Files to read
- The criteria file from the module's `criteria` config (fit assessment)
- `{opportunities}/_index.md` (duplicate check)
- Your identity doc (current positioning)
- Your expertise index, if you keep one (gap analysis)

### Files to write or modify
- Create: `{opportunities}/{company-slug}/status.md`
- Create (optional): `{opportunities}/{company-slug}/research.md`
- Run: `brain jobs pipeline`, which regenerates `{opportunities}/_index.md`

### External sources (WebFetch/WebSearch)
- The job listing URL, the company website, funding databases, professional
  networks, news coverage

### Workflow position
- **Before**: a role turns up — manually, or from `brain jobs review`
- **After**: if pursuing, prepare materials; when a call is booked, use
  `/interview-scheduled`

## Pipeline fields

`status.md` records where the opportunity stands, and the pipeline index is
generated from it:

- `stage`: `researching` → `applied` → `screening` → `interviewing` → `offer`,
  or `closed` at any point.
- `fit`: `strong`, `medium` or `weak`, from the fit assessment.
- `applied`: the date the application went out.
- `next_step`: what happens next, in a few words; its date goes in `deadline`,
  which is what `brain briefing` lists under Upcoming Deadlines.
- `closed_reason`: why it ended, when `stage` is `closed`. Closing also sets
  `relevance: historical`.

After changing any of them, bump `updated` and run `brain jobs pipeline`.

## Notes

- If fetching the listing URL fails, ask for pasted text instead of retrying.
- Be honest about gaps. Candid beats encouraging.
- Ground the fit assessment in specific lines from the criteria file, not
  generic observations.
- Do not create `research.md` when there is barely anything to put in it.
- The closing discussion is the point. The files are for future reference; the
  conversation is where the decision happens.
