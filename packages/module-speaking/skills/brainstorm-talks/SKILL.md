---
name: brainstorm-talks
description: Iterative, collaborative brainstorming for developing talk concepts. Generates ideas, then refines based on feedback to build 3-5 polished options. Use when you need fully developed concepts through interactive dialogue.
---

# Collaborative Talk Brainstorming

## Prompts

### Phase 1: Starting Point
1. **What's your starting point?**
   - Conference context (name, year, priorities from research)
   - OR expertise area to explore
   - OR a rough idea/concept to develop

2. **Format preferences** (optional):
   - Full talk (45 min), short talk (30 min), workshop (60 min), lightning (5-10 min)

### Phase 2: Initial Generation (auto-generated)
Generates 3-5 initial talk concepts based on starting point.

### Phase 3: Collaborative Refinement (loop until satisfied)
3. **Feedback on ideas**: Which concepts resonate? What's missing? Deepen any? Combine elements?
4. **Direction for next iteration**: "Deepen #2", "Add another X idea", "Merge #1 and #3", "Try different angle on Y", "Workshop version of #4"
5. **Continue until** user indicates satisfaction

### Phase 4: Final Output
6. **Output format preference**: Update existing talk-ideas.md, create new file, inline only, or named file

## Actions

### Phase 1: Context Gathering
1. Read starting material:
   - If conference: `conferences/{name}-{year}/conference-research.md`
   - If expertise: your identity/expertise docs (e.g. under `me/` — research themes, areas of expertise)
   - Also read `talks/_index.md` for existing talk themes (avoid duplication)
2. Identify constraints, audience, themes

### Phase 2: Initial Generation
3. Generate 3-5 concepts with: working title, format, target audience, hook, learning points
4. Present numbered list, ask for feedback

### Phase 3: Refinement Loop
5. Process feedback: preferred concepts, changes, additions, combinations
6. Generate next iteration based on direction
7. Present refined concepts, ask for next round
8. Repeat until satisfied

### Phase 4: Finalization
9. Based on output preference:
   - **Update talk-ideas.md**: `conferences/{name}-{year}/talk-ideas.md`
   - **Create named file**: `conferences/{name}-{year}/talk-ideas-{context}.md`
   - **Inline only**: present final concepts
10. New/updated files use frontmatter:
    ```yaml
    type: conference
    title: "Talk Ideas: {Conference} {Year}"
    created: {YYYY-MM-DD}
    updated: {YYYY-MM-DD}
    tags: [conference, talk-ideas, {conference-slug}]
    status: active
    relevance: primary
    ```
11. Update `conferences/{name}-{year}/status.md` if exists
12. Update `conferences/_index.md` (Index Sync Principle): if the conference
    directory exists, ensure it has a row and its Status column reflects the
    current state (e.g. "Ideas drafted — no submission yet"); bump the index's
    frontmatter `updated` if the row changed
13. Suggest next step: `/new-submission` for chosen concept

## References

### Files to Read
- `conferences/{name}-{year}/conference-research.md` (if conference context)
- Your identity/expertise docs (e.g. under `me/`) — expertise areas and research themes
- Your content-strategy doc, if you keep one (core themes and voice)
- `talks/_index.md` (existing talk themes to avoid duplication)
- `conferences/{name}-{year}/talk-ideas.md` (if updating existing)

### Files to Write/Modify
- Create/update: `conferences/{name}-{year}/talk-ideas.md` or `talk-ideas-{context}.md`
- Modify: `conferences/{name}-{year}/status.md`
- Modify: `conferences/_index.md` (conference row status, if dir exists)

### Workflow Position
- **Before**: `/conference-research` to inform context
- **After**: `/new-submission` to create CFP

## Notes

### vs. `/talk-ideas`
Use `/brainstorm-talks` for interactive development. Use `/talk-ideas` for quick one-shot generation.

### Quality Indicators
- **Specific**: "Schema That Actually Talks to Agents" vs "Schema for AI"
- **Concrete learning bullets**: "3 schema types to prioritize" vs "Learn about schema"
- **Clear differentiation**: What makes this distinctive
- **Audience fit**: Explicitly stated who benefits
- **Actionable outcomes**: What capability attendees gain
