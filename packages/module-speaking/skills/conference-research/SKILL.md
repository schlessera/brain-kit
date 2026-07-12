---
name: conference-research
description: Researches a conference by finding CFP details, analyzing past themes, identifying audience characteristics, and documenting findings. Use before /talk-ideas and /new-submission.
---

# Conference Research

## Prompts

1. **Conference name**: What is the name of the conference?
2. **Conference year**: What year? (YYYY format)
3. **Website URL** (recommended): What's the conference website?
4. **Current knowledge** (optional): What do you already know about this conference?

## Actions

1. **Check for existing research**:
   - Check if `conferences/{name}-{year}/conference-research.md` exists
   - If exists, ask: Update existing or create fresh?

2. **Research CFP details** (if website provided or can be found):
   - Locate CFP page
   - Extract: dates, deadlines, format requirements, word counts, submission process
   - Record: Notification timeline

3. **Analyze past conferences** (if accessible):
   - Past speakers (names, companies, talk titles)
   - Attendee size and composition
   - Themes and topics from previous years
   - Format patterns (keynote vs breakout vs workshop)

4. **Identify conference priorities**:
   - Topics listed as priorities in CFP
   - Organizers' focus areas
   - Specific challenges they want addressed
   - Preferred formats and durations

5. **Research audience characteristics**:
   - Primary audience roles
   - Technical level expectations
   - Industry focus
   - Regional characteristics

6. **Identify differentiation opportunities**:
   - Gaps in past speakers
   - Unique angles you can offer
   - How your expertise aligns with priorities

7. **Create conference-research.md**:
   - Path: `conferences/{name}-{year}/conference-research.md`
   - Frontmatter:
     ```yaml
     type: conference
     title: "Conference Research: {Conference Name} {Year}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [conference, research, {conference-slug}]
     status: active
     relevance: primary
     summary: "CFP and conference research for submission strategy"
     ```
   - Sections: Conference Overview, CFP Details & Requirements, Past Conference Analysis, Audience Profile, Format Preferences, Conference Priorities & Themes, Differentiation Opportunities, Key Dates & Timeline

8. **Update status.md** (if exists): note research completed, update `updated` field

9. **Output summary**: path, key highlights, next suggestions (use `/talk-ideas` or `/new-submission`)

## References

### External Sources (WebFetch/WebSearch)
- Conference website (CFP, about page, program)
- Previous year's conference sites

### Files to Read
- `conferences/{name}-{year}/conference-research.md` (if exists)
- `conferences/{name}-{year}/status.md` (if exists)
- Your content-strategy doc, if you keep one (for strategic alignment)

### Files to Write/Modify
- Create/update: `conferences/{name}-{year}/conference-research.md`
- Modify (if applicable): `conferences/{name}-{year}/status.md`

### Workflow Position
- **Before**: Starting point for new conferences
- **After**: Use `/talk-ideas` or `/brainstorm-talks` with research context

## Notes

- Research depth depends on available information
- Focus on info that affects submission success: audience, format, priorities
- Research file is a living document — can be updated
- Complete research includes: CFP deadlines, 2-3 past speakers, audience profile, format preferences, 3-5 priority themes, differentiation observations
