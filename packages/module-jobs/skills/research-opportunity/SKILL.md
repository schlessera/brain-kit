---
name: research-opportunity
description: Researches a job opportunity from a URL or pasted job description, assesses fit against your search criteria, stores it in the opportunity tracker, and discusses whether to pursue. Use when a role turns up that is worth evaluating properly.
---

# Research Opportunity

Turns a job listing into a tracked opportunity: extracted details, company
research, an honest fit assessment against your own criteria, and a
conversation about whether to pursue it.

The opportunity directory is whatever `opportunitiesDir` is set to in the jobs
module config (default `career/opportunities/`). Paths below use that default;
substitute your own.

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
   `career/opportunities/{company-slug}/` already exists, ask whether to update
   it or stop.

4. **Research the company.** What they build, products, size and stage,
   funding, tech stack, recent news, culture signals, and the people who would
   be in the loop (engineering leadership, the likely hiring manager). Depth
   depends on what is publicly available — do not force it when there is
   little to find.

5. **Read the context you need to judge fit.**
   - The criteria file named by the jobs module's `criteria` config (default
     `career/opportunities/search-criteria.md`) — must-haves, strong
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
   - Path: `career/opportunities/{company-slug}/status.md`
   - Frontmatter:
     ```yaml
     type: opportunity
     title: "{Company Name} — {Role Title}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [job-search, opportunity, {company-slug}]
     relevance: primary
     summary: "{Role Title} at {Company Name} — {one line}"
     ```
   - Sections:
     - **Overview** — company, role, location, source, listing URL, Status
       (`researching`)
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
   - Path: `career/opportunities/{company-slug}/research.md`
   - Frontmatter mirrors `status.md` with `title: "{Company Name} — Research"`
     and `tags: [job-search, research, {company-slug}]`.
   - Sections: Company Overview, Why This Could Work, Concerns / Red Flags,
     Relevant Connections, Key People.
   - Skip the file entirely when research was thin. A stub is worse than
     nothing.

9. **Update the pipeline index** — add a row to
   `career/opportunities/_index.md`:
   `| {Company} | {Role} | researching | {YYYY-MM-DD} | {strong/moderate/weak/assessing} | [{company-slug}]({company-slug}/) |`
   and bump the file's `updated`.

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
- `career/opportunities/_index.md` (duplicate check, pipeline row)
- Your identity doc (current positioning)
- Your expertise index, if you keep one (gap analysis)

### Files to write or modify
- Create: `career/opportunities/{company-slug}/status.md`
- Create (optional): `career/opportunities/{company-slug}/research.md`
- Modify: `career/opportunities/_index.md`

### External sources (WebFetch/WebSearch)
- The job listing URL, the company website, funding databases, professional
  networks, news coverage

### Workflow position
- **Before**: a role turns up — manually, or from `brain jobs review`
- **After**: if pursuing, prepare materials; when a call is booked, use
  `/interview-scheduled`

## Notes

- If fetching the listing URL fails, ask for pasted text instead of retrying.
- Be honest about gaps. Candid beats encouraging.
- Ground the fit assessment in specific lines from the criteria file, not
  generic observations.
- Do not create `research.md` when there is barely anything to put in it.
- The closing discussion is the point. The files are for future reference; the
  conversation is where the decision happens.
