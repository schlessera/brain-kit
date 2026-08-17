---
name: talk-prep
description: Use once a talk is accepted and the presentation materials need building — the public description, the session outline, who the audience is, and the speaking notes.
---

# Talk Preparation

## Prompts

1. **Talk title or path**: What's the talk title? Or provide existing submission file path
2. **Conference context**: What conference is this for? (name and year)
3. **Talk format**: 45-minute talk, 30-minute talk, 60-minute workshop, lightning (5-10 min), other

## Actions

1. **Locate source material**:
   - If submission path provided, read it
   - If only title: check `conferences/{name}-{year}/submission-*.md` for match
   - Check if `talks/{slug}/description.md` exists
   - If no source found, prompt for abstract and key points

2. **Create talk directory** (if needed):
   - Use kebab-case slug: `talks/{slug}/`
   - Match the slug to the existing talk registry file name (e.g., `talks/distributed-systems-in-practice.md` → `talks/distributed-systems-in-practice/`)

3. **Create brain registry entry** (if `talks/{slug}.md` doesn't exist):
   - Frontmatter:
     ```yaml
     type: talk
     title: "{Talk Title}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [{relevant-tags}]
     status: active
     relevance: primary
     format: {seminar|workshop|panel|lightning}
     duration: {minutes}
     level: {beginner|intermediate|advanced}
     summary: "{one-line summary}"
     ```
   - Sections: Abstract, Deliveries table, Proposals table, Resources

4. **Generate description.md**:
   - Path: `talks/{slug}/description.md`
   - Frontmatter: `type: talk`, title, dates, tags
   - Content: title, 2-3 paragraph summary, core themes (3-5), technical level, target audience

5. **Generate session-outline.md**:
   - Path: `talks/{slug}/session-outline.md`
   - Frontmatter: `type: talk`, title, dates, tags
   - Structure: Opening/Hook (2-3 min), Problem statement (5 min), Core sections (3-5 at 8-10 min each), Demo/Examples (if applicable), Q&A, Closing (2-3 min)
   - Time allocations adjusted for specified format
   - Read existing `talks/*/session-outline.md` for pattern reference

6. **Generate target-audience.md**:
   - Path: `talks/{slug}/target-audience.md`
   - Frontmatter: `type: talk`, title, dates, tags
   - Content: Primary audience (roles, experience), Prerequisites, What attendees leave with, Who should NOT attend

7. **Generate speaking-notes.md**:
   - Path: `talks/{slug}/speaking-notes.md`
   - Frontmatter: `type: talk`, title, dates, tags
   - Structure: section-by-section speaking prompts, key phrases, transitions, timing checkpoints, demo markers, stories/anecdotes with delivery notes
   - NOT a word-for-word script — outline for extemporaneous delivery
   - Read existing `talks/*/speaking-notes.md` for pattern reference

8. **Suggest additional files** (if appropriate):
   - Technical talk/demo → suggest `demo-script.md`
   - Multiple formats → suggest `alternative-outline.md`
   - Workshop → suggest `workshop-exercises.md`

9. **Update linked files**:
   - Update `conferences/{name}-{year}/status.md` if submission status needs updating
   - Use `[[wiki-links]]` for cross-references between brain files

10. **Verify the talk's registry state in `talks/_index.md`** (Index Sync
    Principle):
    - If this talk has PAST deliveries, confirm each has a row in the
      delivered-talks tables linking to `[[{slug}]]` — add any missing rows
    - If the talk is new (no delivery yet), do NOT add a delivered row —
      `/conference-aftermath` adds it after delivery — but confirm the
      `talks/{slug}.md` registry file from step 3 exists and is linked from
      the prep materials

11. **Output summary**: files created with paths, length of each, next steps

## References

### Files to Read
- `conferences/{name}-{year}/submission-{slug}.md` (if exists)
- `talks/{slug}.md` (registry entry, if exists)
- `talks/*/session-outline.md` (structure patterns)
- `talks/*/speaking-notes.md` (notes patterns)
- Your content-strategy doc, if you keep one

### Files to Write/Modify
- Create: `talks/{slug}/description.md`
- Create: `talks/{slug}/session-outline.md`
- Create: `talks/{slug}/target-audience.md`
- Create: `talks/{slug}/speaking-notes.md`
- Create (if needed): `talks/{slug}.md` (registry entry)
- Suggest: `demo-script.md`, `alternative-*.md`
- Modify: `conferences/{name}-{year}/status.md`
- Modify (if past deliveries missing): `talks/_index.md`

### Workflow Position
- **Before**: `/new-submission` → acceptance
- **After**: Practice, build slides, deliver

## Notes

- Speaking notes are an OUTLINE, not a script — for extemporaneous delivery
- Time allocations are estimates — user should time practice sessions
- If talk has complex demo, strongly suggest separate `demo-script.md`
- Alternative outlines useful for 30/45/60 min versions of same talk
- Always match tone to target audience
- All created files use brain frontmatter schema (type, title, created, updated, tags)
