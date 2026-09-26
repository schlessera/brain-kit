---
name: conference-aftermath
description: Use after getting back from a conference, ideally within 48 hours — to capture the reflection while it is fresh, record that the talk was delivered, and close out the conference and its trip.
---

# Conference Aftermath

Wraps up a conference once you're back: capture the reflection, land the
delivery in the talk registry, and archive the conference + trip (Index Sync
Principle — "conference over" must propagate to every layer).

## Prompts

1. **Conference name**: What conference did you attend?
2. **Did you speak?**: Yes (speaker perspective) / No (attendee perspective)
3. **Talk title** (if spoke): What was your talk title?
4. **2-3 highlights**: Key highlights — specific sessions, conversations, observations, surprises
5. **Personal takeaways**: Main takeaway or reflection
6. **Optional**: Location, thanks to organizers/people, something you're bringing back to work

## Actions

1. **Read context**:
   - `talks/{slug}.md` (if spoke — delivery context)
   - Your writing-style/voice doc, if you keep one (tone and voice)

2. **Write the retrospective** — publishing is pluggable:
   - **If a content/publishing workflow is configured** (e.g. a personal overlay
     skill that drafts social posts), hand the highlights + reflection off to it
     and let it own the draft, then link the draft from the conference dir.
   - **Otherwise**, write a plain retrospective note in the conference dir:
     - Path: `conferences/{name}-{year}/aftermath.md`
     - Frontmatter:
       ```yaml
       type: conference
       title: "{Conference} {Year} — Retrospective"
       created: {YYYY-MM-DD}
       updated: {YYYY-MM-DD}
       tags: [conference, aftermath, {conference-slug}]
       status: active
       relevance: primary
       summary: "Post-conference reflection"
       ```
     - Content: hook ("Back from {Conference} with {reaction}"), highlights, reflection, thank-yous, and what you're bringing back to work. Match your own voice if a writing-style doc exists.

3. **Record the delivery in `talks/_index.md`** (if you spoke — Index Sync
   Principle: "Talk delivered" must land in the delivered registry):
   - Add a row to the year's table: Date (YYYY-MM), Talk, Event, Location,
     `[[talk-slug]]` file link (create the year section if missing)
   - Skip if the delivery row already exists

4. **Archive the conference and related travel** (the conference is over):
   - Archive the conference's files in `conferences/{name}-{year}/` (at minimum
     `status.md`) with `brain archive <path>` (or the `brain_archive` tool), one
     file at a time. Do not set `status: archived` by hand: archiving also
     demotes the file's relevance, so it stops outranking current work.
   - Archive the linked trip's files in `travel/{trip-slug}/` the same way, if
     the trip is completed
   - Update the corresponding rows in `conferences/_index.md` and
     `travel/_index.md` to an archived/past status, and bump `updated` on each
     index you edit

5. **Output summary**: retrospective path (or the draft handed to the publishing
   workflow), registry/index updates, and a reminder to publish within 48 hours
   if you post about conferences

## References

### Files to Read
- Your writing-style/voice doc, if you keep one (tone and voice)
- `talks/{slug}.md` (if spoke — for delivery context)
- The conference's `status.md` and the linked trip's files (to archive them)

### Files to Write/Modify
- Create: `conferences/{name}-{year}/aftermath.md` (or a draft owned by a configured publishing workflow)
- Modify: `talks/_index.md` (add delivery row, if spoke)
- Modify: `conferences/{name}-{year}/status.md` + `conferences/_index.md` (archive)
- Modify: `travel/{trip-slug}/*` + `travel/_index.md` (archive, if trip completed)

### Workflow Position
- **Before**: Deliver conference talk
- **After**: Publish the retrospective (if you post) and move on

## Notes

- If you post about conferences, do it within 48 hours for relevance
- Be specific — name talks, conversations, people
- Focus on learning, not humble-bragging
- If you spoke, emphasize audience feedback and conversations; if you attended, emphasize what you learned
- Include genuine gratitude to organizers
- The publishing step is intentionally pluggable: keep the content/social workflow
  in your own overlay so this module stays about the speaking lifecycle, not any
  one platform
