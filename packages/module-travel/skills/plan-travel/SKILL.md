---
name: plan-travel
description: Use when a trip needs planning, for a conference or otherwise — especially right after a talk is accepted or attendance is confirmed, and whenever a traveler has requirements that need lead time to arrange.
---

# Plan Travel

Turns the documented travel conventions into an executable workflow. The travel
party is not hardcoded: read it from the travel module's `travelParty` config
(in `brain.config`) and plan for every configured member unless told otherwise.
Read the complete module mapping with `brain config get modules` and select
`@schlessera/brain-module-travel`; package names contain dots, so they are not
a single segment of the config command's dotted-path syntax.
Each member may have a `requirementsDoc` — a file describing their
travel-relevant needs (accessibility, an assistance animal, a child, a visa or
passport constraint, dietary needs). Read those docs and fold each member's
requirements into the itinerary.

## Prompts

1. **Destination / occasion**: Where and why? (conference, event, personal)
2. **Dates**: Departure and return (approximate is fine at planning stage)
3. **Travelers**: The configured `travelParty` is the default — confirm who's coming this time
4. **Transport mode**: Car, train, flight (affects per-traveler requirements significantly)
5. **Linked conference** (if any): the `conferences/{name}-{year}/` directory

## Actions

1. **Derive the trip slug**: kebab-case, descriptive, matching existing patterns
   (`ithaca-homecoming`, `scheria-visit`, `troy-to-ithaca`). Check
   `travel/{trip-slug}/` doesn't already exist; if it does, update rather than duplicate.

2. **Read context**:
   - The `travelParty` config for this module — the members to plan for
   - Each member's `requirementsDoc` (if set) — their canonical travel requirements
   - The linked conference's `status.md` (dates, venue, city) if conference-related
   - An existing itinerary under `travel/` as the structural model, if you have one

3. **Create `travel/{trip-slug}/itinerary.md`**:
   - Frontmatter:
     ```yaml
     type: travel
     title: "{Trip Name}"
     created: {YYYY-MM-DD}
     updated: {YYYY-MM-DD}
     tags: [travel, {destination}, {occasion-tags}, itinerary]
     status: active
     relevance: primary
     summary: "{One line: dates, route, occasion, travelers}"
     deadline: {departure date}
     ```
   - Sections:
     - **At a Glance** — dates, route/from, transport, accommodation, events, travelers
     - **Day-by-Day** — transport legs with times where known, event days, return
     - **Traveler Requirements** — one checklist block **per configured member who
       has a `requirementsDoc`**. Pull the specifics from that member's doc; the
       full detail lives in the doc (link it as `[[…]]`). Typical items, depending
       on the member:
       - [ ] Required paperwork packed (IDs, passports/visas, medical or assistance-animal certificates, EU pet passport, emergency cards — per the member's doc)
       - [ ] Carrier notified / booking annotated where advance notice is required (flights especially: airline policies differ for assistance animals, so notify at booking, not check-in)
       - [ ] Accommodation notified in advance of any accessibility need or assistance animal (often legally required to accommodate; notice reduces friction)
       - [ ] Venue access confirmed with organizers (conference/event days)
       - [ ] Comfort logistics: breaks on long drives, water/food/medication kit, weather gear, mobility aids as applicable
     - **Open Items** — explicitly note when a traveler's participation is unconfirmed (dates, whether they join, their own commitments)
     - **Links** — wiki-links to the conference hub and `[[travel/_index]]`
   - Wiki-link the conference file (qualify duplicated filenames: `[[{conference-dir}/status]]`)

4. **Update `travel/_index.md`**:
   - Add a row: Trip (linked `[{Name}]({trip-slug}/)`), Dates, Route, Conference (`[[wiki-link]]` or —), Status `Planning`
   - Bump frontmatter `updated`

5. **Cross-link from the conference** (if conference-related):
   - Add or update a `## Travel` section in `conferences/{name}-{year}/status.md` referencing `[[{trip-slug}/itinerary]]`, travelers, and route; bump `updated`
   - Per the Index Sync Principle, also reflect the trip in the conference's `conferences/_index.md` row if it mentions travel

6. **Optional companion files** — only when there's real content (directory
   convention in `travel/_index.md`): `accommodation.md`, `logistics.md`, `budget.md`, `checklist.md`.

## References

### Files to Read
- The travel module `travelParty` config (members + each `requirementsDoc`)
- `travel/_index.md` (registry + directory convention)
- An existing `travel/*/itinerary.md` (structural model), if you have one
- Each traveler's `requirementsDoc` (accessibility, assistance animal, child, visa, dietary)
- `conferences/{name}-{year}/status.md` (if conference-linked)

### Files to Write/Modify
- Create: `travel/{trip-slug}/itinerary.md`
- Modify: `travel/_index.md` (add trip row)
- Modify (if conference-linked): `conferences/{name}-{year}/status.md` (Travel section)

### Workflow Position
- **Before**: talk accepted (`/submission-outcome`) or attendance decided
- **After**: bookings land → update itinerary + index Status to `Booked`; journey completed → record it on the itinerary as a `visits:` entry (stable `id`, `date`, `party`) and link the places it reached with `/places`, run `brain travel validate` and `brain travel sync`, then use `brain archive <path>` for its completed files. Day outings are trips, not journeys: use `/trip-log`. A conference-linked journey can close during `/conference-aftermath`; personal journeys do not need a conference.

## Notes

- Status progression in `travel/_index.md`: Planning → Booked → archived. Confirm completion before archiving; an elapsed departure date does not prove the journey happened.
- The `deadline` frontmatter (departure date) makes the trip surface in `/whatsup` — keep it accurate if dates shift
- Flights are the high-friction mode for travelers with an assistance animal or accessibility need — carrier policies differ; flag this early so notification happens at booking, not at check-in
- Don't guess an unconfirmed traveler's availability — list it under Open Items until confirmed
- For a shareable day plan, follow `generate-pdf` and render as kind `itinerary` (`brain render --kind itinerary --scaffold`). Sections in this order: The day (timeline), The route, Pack (checklist, one per traveler with requirements), Food and stays. Write the HTML and the PDF to `travel/{trip-slug}/`. No CSS of your own
