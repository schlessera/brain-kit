---
name: new-submission
description: Use when submitting a talk to a conference call for papers — choosing the bio, writing the abstract and takeaways, and putting the submission under tracking.
disable-model-invocation: true
---

# New Conference Submission

## Prompts

1. **Conference name**: What is the name of the conference?
2. **Conference year**: What year? (YYYY format)
3. **Talk title**: What is your proposed talk title?
4. **Talk slug**: Short URL-friendly version (lowercase, hyphens)
5. **Format**: 45-minute talk, 30-minute talk, 60-minute workshop, lightning (5-10 min), other
6. **Target audience**: e.g. backend developers, platform engineers, general technical, or another audience the conference draws
7. **Key themes**: the 1-3 themes this talk leans on (pull from your identity/expertise or content-strategy docs)

## Actions

1. **Create conference directory** (if needed):
   - Check if `conferences/{name}-{year}/` exists
   - Create `status.md` if doesn't exist

2. **Select appropriate bio**:
   - Read your speaker bios (e.g. `me/bios/` kept at several lengths)
   - Select based on audience/form limit: a long bio (~300 chars) for general forms, a medium (~150) for formal ones, a short (~50) for tight fields

3. **Check prior submissions**:
   - Read `talks/_proposals.md` for related prior submissions to this conference or on similar topics
   - Note any relevant history (previous rejections, accepted talks, etc.)

4. **Generate abstract** (300-500 words):
   - Read your content-strategy doc (if you keep one) for core themes
   - Align with talk title, themes, and conference audience
   - Include: problem statement, what attendees learn, why this matters now, specific examples

5. **Generate takeaways** (3-5 bullet points): concrete, actionable, audience-specific

6. **Create submission file**:
   - Path: `conferences/{name}-{year}/submission-{slug}.md`
   - Frontmatter:
     ```yaml
     type: conference
     title: "Submission: {Talk Title}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [conference, submission, {conference-slug}, {theme-tags}]
     status: active
     relevance: primary
     summary: "CFP submission for {Conference} {Year}"
     ```
   - Sections: Talk Title, Format & Duration, Abstract, Target Audience, Prerequisites, Takeaways, Speaker Bio

7. **Update status.md**:
   - Add submission with: title, format, status "Submitted — awaiting decision", link to file
   - Update `updated` field

8. **Update `conferences/_index.md`** (Index Sync Principle — never leave the
   summary layer stale):
   - If the conference has no row yet, add one (Conference, Dates, Location, Status)
   - Update the row's Status to reflect the new submission (e.g. "1 submitted — awaiting decision")
   - Bump the index file's frontmatter `updated`

## References

### Files to Read
- Your speaker bios (e.g. `me/bios/` at several lengths)
- Your content-strategy doc, if you keep one
- `talks/_proposals.md` (prior submission history)
- `conferences/{name}-{year}/status.md` (if exists)
- `conferences/{name}-{year}/conference-research.md` (if exists)

### Files to Write/Modify
- Create: `conferences/{name}-{year}/submission-{slug}.md`
- Create (if needed): `conferences/{name}-{year}/status.md`
- Modify: `conferences/{name}-{year}/status.md`
- Modify: `conferences/_index.md` (conference row status)

### Workflow Position
- **Before**: `/conference-research` and `/talk-ideas` or `/brainstorm-talks`
- **After**: Wait for acceptance, then `/talk-prep`

## Notes

- Ask if conference has specific requirements (word limits, specific questions)
- If your bios are organized by length, note whether the numbers are **characters**
  or words — pick the file whose target matches the CFP form's limit. A ~300-char
  bio is a sensible default for typical submission forms
- Abstract should be concise but comprehensive
- Takeaways should be concrete and measurable
- Always use current date for frontmatter
