---
name: talk-ideas
description: Use when a conference needs talk concepts quickly — a one-shot set of tailored ideas to choose from. For developing concepts through dialogue instead, use /brainstorm-talks.
---

# Talk Ideas Generation

## Prompts

1. **Conference name**: What is the name of the conference?
2. **Conference year**: What year? (YYYY format)
3. **Conference research** (optional): Path to research file, or provide:
   - Conference focus areas/themes
   - Primary audience
   - CFP priorities or requirements
4. **Expertise areas to emphasize** (optional): If not specified, uses all current focus areas from your identity/expertise docs

## Actions

1. **Create conference directory** (if needed): `conferences/{name}-{year}/`

2. **Read conference context**:
   - `conferences/{name}-{year}/conference-research.md` (if exists)
   - Ask for focus areas if no research file

3. **Read expertise areas**:
   - Your identity/expertise docs (e.g. under `me/`) — current research themes, areas of expertise
   - Your content-strategy doc, if you keep one — core themes
   - `talks/_index.md` — existing talks to avoid duplication

4. **Map expertise to conference**: Cross-reference, prioritize matching themes, identify unique angles

5. **Generate 3-5 talk concepts**, each with:
   - Working title (catchy, descriptive)
   - Format recommendation (talk/workshop/lightning)
   - Target audience specification
   - Hook: Opening statement
   - What You'll Learn: 3-4 bullet points
   - Unique Angle: What makes this distinctive
   - Conference Fit: Why this matches this conference

6. **Suggest additional formats**: 1 lightning talk, 1 workshop (if appropriate), note format-scalable talks

7. **Create/update talk-ideas.md**:
   - Path: `conferences/{name}-{year}/talk-ideas.md`
   - Frontmatter:
     ```yaml
     type: conference
     title: "Talk Ideas: {Conference} {Year}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [conference, talk-ideas, {conference-slug}]
     status: active
     relevance: primary
     ```

8. **Update status.md** if exists

9. **Update `conferences/_index.md`** (Index Sync Principle): if the
   conference directory exists, make sure the index has a row for it and its
   Status column reflects the current state (e.g. "Ideas drafted — no
   submission yet"). Bump the index's frontmatter `updated` if the row changed.

## References

### Files to Read
- Your identity/expertise docs (e.g. under `me/`) — research themes, areas of expertise
- Your content-strategy doc, if you keep one
- `talks/_index.md` (existing talk themes)
- `conferences/{name}-{year}/conference-research.md` (if exists)

### Files to Write/Modify
- Create/update: `conferences/{name}-{year}/talk-ideas.md`
- Modify: `conferences/{name}-{year}/status.md`
- Modify: `conferences/_index.md` (conference row status, if dir exists)

### Workflow Position
- **Before**: `/conference-research` to inform context
- **After**: `/new-submission` for chosen concept

## Notes

- Generated ideas are starting points — user refines before submission
- Emphasis on practical, actionable content
- Include "unique angle" per talk
- Note which ideas could serve as lightning + full talk versions
- After review, selected ideas → `/new-submission`
