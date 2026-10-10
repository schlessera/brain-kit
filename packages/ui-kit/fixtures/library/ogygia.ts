// Library domain: ogygia. See ../README.md and ./types.ts.
//
// Seven years of records from Calypso's island, day 1,095 to this morning:
// the cave and its surroundings, the household, the weather, one summary per
// year, and the four-day build that ends the stay. Nothing here reports the
// raft as launched; the launch is planned for the seven o'clock tide.

import type { LibraryDocument } from "./types.js";

export const ogygiaDocuments: LibraryDocument[] = [
  /* ------------------------------------------------------------ the island */
  {
    path: "ogygia/island/day-1095-landfall.md",
    title: "Day 1,095 -- landfall",
    type: "log",
    created: "2019-07-12",
    updated: "2019-07-20",
    status: "closed",
    tags: ["landfall", "island"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Ten nights on the keel after Charybdis. Came ashore on the tenth, alone, and was taken in.",
    body: `Written up a week after the fact, when I could hold the phone steady.

## What happened
- Day 1,084: the ship broke up in the storm after Thrinacia ([[voyage/day-1084-the-storm]]).
- Day 1,085: Charybdis a second time. Held the fig tree over [[knowledge/charybdis]] until the mast and keel came back up, then rode them ([[decisions/hold-the-fig-tree]]).
- Nine days adrift. No food after the second day. Water from rain off my own hair.
- Tenth night: driven onto this island. Came ashore on the keel and nothing else.

## Count
One man landed. The crew ledger was already closed when I lost the ship: see [[crew/_index]] and [[crew/roll-calls/day-1095]]. Nothing aboard survived but what I was wearing.

## Who took me in
A woman living in a cave above the beach, with no household I could see. She gave her name as Calypso, daughter of Atlas. Fed, warmed, slept. Filed under [[people/calypso]].

> First note to self: find out where this is, and how far it is from anywhere.

That question has its own record now: [[ogygia/island/survey]]. The journal for the day: [[journal/day-1095]]. Indexed under [[ogygia/_index]].`,
    links: ["knowledge/charybdis.md", "crew/_index.md", "people/calypso.md", "ogygia/island/survey.md", "ogygia/_index.md", "voyage/day-1084-the-storm.md", "decisions/hold-the-fig-tree.md", "crew/roll-calls/day-1095.md", "journal/day-1095.md"],
    fields: { day: 1095, survivors: 1, source: "first-hand" },
  },
  {
    path: "ogygia/island/survey.md",
    title: "Walk-around survey",
    type: "survey",
    created: "2019-07-21",
    updated: "2019-08-30",
    status: "done",
    tags: ["island", "survey"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Walked the whole shoreline in a day and a half. No harbour, no settlement, no hulls, no smoke but hers.",
    body: `Walked the coast clockwise from the cave beach. One and a half days at an easy pace, sleeping out one night on the headland.

| Section | What is there |
|---|---|
| Cave beach | Sand, the only easy landing. Below the cave. |
| North shore | Low cliff, rock shelves, no landing in any sea. |
| Headland | High ground, clear view east and north. See [[ogygia/island/headland]]. |
| West shore | Shingle, steep. Driftwood, nothing worked. |
| South shore | Cliff. Birds nesting. No way down. |

## Findings
- No harbour. No beached hull, no hull timbers, no oars, no cordage on any beach.
- No other house, no field boundary, no path but the ones to the springs.
- Woods inland, good timber, never cut. See [[ogygia/island/woods]].
- Fresh water in four places. See [[ogygia/island/springs]].

## Conclusion
An island in the middle of the sea, with no traffic that comes near it. Anyone leaving it leaves on something they built ([[decisions/build-rather-than-wait]]). Nothing to build with yet. The journal of those weeks: [[journal/day-1110]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/headland.md", "ogygia/island/woods.md", "ogygia/island/springs.md", "ogygia/_index.md", "decisions/build-rather-than-wait.md", "journal/day-1110.md"],
    fields: { day: 1104, duration: "1.5 days", settlements: 0, harbours: 0 },
  },
  {
    path: "ogygia/island/cave.md",
    title: "The cave",
    type: "place",
    created: "2019-07-25",
    updated: "2026-07-11",
    status: "reference",
    tags: ["island", "cave"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "Deep, dry, warm in winter and cool in summer. Her house, and for seven years mine.",
    body: `Above the beach, facing the sea. The mouth is wide enough to stand in three abreast and is grown over by the vine (see [[ogygia/island/vine]]).

## Layout
- **Mouth**: the hearth, where the cooking and the talking happen. See [[ogygia/island/hearth]].
- **Main chamber**: her loom, the storage jars, the table. See [[ogygia/routine/loom]].
- **Inner chambers**: dry; the stores and the cloth are kept here.
- No door. Nothing on the island to keep out.

## Notes
- The floor stays dry in the worst of the winter rain. I checked every winter for seven years; it never once ran.
- Smoke draws out of the mouth unless the wind is in the east, which is rare.
- My own corner holds a bed, the phone, the clothes she gave me, and since day 3,648 the borrowed tools at night.

It is the most comfortable place I have lived since I left my own house ([[ithaca/hall/plan]]). That has not been the problem. Filed under [[ogygia/_index]]; owner [[people/calypso]]. First night here: [[journal/day-1095]].`,
    links: ["ogygia/island/vine.md", "ogygia/island/hearth.md", "ogygia/routine/loom.md", "ogygia/_index.md", "people/calypso.md", "ithaca/hall/plan.md", "journal/day-1095.md"],
    fields: { place: "Calypso's cave", owner: "Calypso" },
  },
  {
    path: "ogygia/island/hearth.md",
    title: "The hearth",
    type: "place",
    created: "2019-08-02",
    updated: "2025-11-14",
    status: "reference",
    tags: ["cave", "household"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "A great fire at the cave mouth, fed with split cedar and juniper. The smoke carries across the island.",
    body: `The fire at the mouth of the cave is never let out. It burns split cedar and juniper, which she keeps stacked under the overhang, and the smoke smells of both for a long way down the hill. On a still evening it can be smelled from the headland.

## Fuel
| Wood | Used for | Note |
|---|---|---|
| Cedar | The main fire | Splits clean, burns long. |
| Juniper | Kindling, the evening fire | Scented; she prefers it. |
| Driftwood | Never | Salt in it; she will not burn it. |

## My share of the work
- Splitting and carrying, every other day once I could walk the hill again (from about day 1,130).
- Clearing the ash into the garden beds below the cave mouth.

## Why it is in the file
Because in the first year I timed the smoke. If a ship ever passed close, the fire was the signal. None passed close. The timing notes are in [[ogygia/island/sightings]].

The offer was made at this fire: [[decisions/refuse-immortality]], [[journal/day-1575]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/sightings.md", "ogygia/_index.md", "decisions/refuse-immortality.md", "journal/day-1575.md"],
    fields: { fuel: "cedar, juniper", status_of_fire: "never out" },
  },
  {
    path: "ogygia/island/springs.md",
    title: "The four springs",
    type: "place",
    created: "2019-08-10",
    updated: "2026-07-10",
    status: "reference",
    tags: ["island", "water"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Four springs near the cave, running in four directions. Never dry in seven summers.",
    body: `Four springs rise close together on the slope by the cave and run off in four directions. They have not failed in seven summers, which is the longest run of reliable water I have ever had.

| Spring | Runs | Use |
|---|---|---|
| First | Toward the cave mouth | Drinking, the household jars. |
| Second | Down to the meadow | Watering the garden beds. |
| Third | Toward the woods | Washing. |
| Fourth | Down to the shore | Filled the water skin from this one on day 3,651. |

## Flow
Measured by the time to fill a jar, once a season in the first two years and then whenever I remembered. Lowest in late summer, never below half the spring rate.

## The point
Water has never been the problem on the island. It is the problem off it: one skin for seventeen days. That is [[ogygia/stores/water]] and [[studies/water-ration]], not this record.

First noted in [[journal/day-1110]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/stores/water.md", "ogygia/_index.md", "studies/water-ration.md", "journal/day-1110.md"],
    fields: { count: 4, failures: 0 },
  },
  {
    path: "ogygia/island/meadows.md",
    title: "The meadows",
    type: "place",
    created: "2019-08-14",
    updated: "2024-04-22",
    status: "reference",
    tags: ["island", "garden"],
    places: ["place:ogygia"],
    summary: "Soft meadows below the springs, thick with violets and wild parsley. Kept, not farmed.",
    body: `Below the springs the ground opens into soft meadows, wet most of the year, thick with violets and wild parsley. Nobody sows them. They are kept by the water and by being left alone.

## What grows
- Violets, in flower from late winter.
- Wild parsley, all year; picked for the table.
- Grasses, rushes along the runnels from the second spring.

## What I tried
In year two I proposed turning a strip over for barley. She said there was no need, and there was not: the stores have never run down. Recorded so that I do not propose it again.

## Use
- Parsley for the table, most days.
- The walk to the headland crosses the lower meadow; it is the softest ground on the island and the quickest way to the shore.

A place a god would stop to look at, a visitor once said of it, she told me later. I have walked through it on the way to the headland about two thousand times and mostly did not look. First walked in [[journal/day-1110]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/_index.md", "journal/day-1110.md"],
    fields: { sown: false, plants: "violet, parsley" },
  },
  {
    path: "ogygia/island/vine.md",
    title: "The vine over the cave mouth",
    type: "place",
    created: "2019-09-05",
    updated: "2025-09-20",
    status: "reference",
    tags: ["cave", "garden"],
    places: ["place:calypso-cave"],
    summary: "A single old vine trained over the cave mouth. Heavy with grapes every autumn; shade every summer.",
    body: `One vine, very old, grown over the whole mouth of the cave. It is the shade at the hearth in summer and the grapes on the table in autumn.

## Yield, by eye
| Year on the island | Crop | Note |
|---|---|---|
| 1 | Heavy | Arrived in high summer; picked in the first autumn. |
| 2 | Heavy | |
| 3 | Moderate | Late rain split some bunches. |
| 4 | Heavy | |
| 5 | Heavy | |
| 6 | Heavy | Pruned it myself for the first time, under instruction. |
| 7 | Not yet picked | Leaving before the harvest. |

## Note
I asked in year three whether a cutting would take on Ithaca, among my father's vines ([[ithaca/island/orchard]]). She said it would take anywhere it was watered. I have decided not to carry one: see [[ogygia/stores/not-taking]].

A morning in her vines: [[journal/day-3643]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/stores/not-taking.md", "ogygia/_index.md", "ithaca/island/orchard.md", "journal/day-3643.md"],
    fields: { count: 1, crop_years: 6 },
  },
  {
    path: "ogygia/island/woods.md",
    title: "The woods",
    type: "place",
    created: "2019-08-20",
    updated: "2026-07-08",
    status: "reference",
    tags: ["island", "timber"],
    places: ["place:ogygia"],
    summary: "Alder, poplar and cypress round the cave; tall fir further out. Dry, seasoned standing timber, never cut.",
    body: `A wood grows round the cave: alder, poplar and sweet-smelling cypress. Further out, toward the end of the island, stand the tallest trees, alder, poplar and fir, long dead on the stem and dry right through.

## Timber assessment (made in year three, checked on day 3,648)
| Species | Where | Condition | Good for |
|---|---|---|---|
| Alder | Near the cave and far end | Standing dry | Bottom logs, ribs |
| Poplar | Far end | Standing dry | Bottom logs, planking |
| Fir | Far end, tallest | Standing dry | Mast, yard, oar, deck |
| Cypress | Round the cave | Live | Not for cutting; hers |

## Why it took seven years
The timber was here from the first day. A tool to cut it was not, and she held the only ones. In year three I marked the trees I would want; the marks had grown over by the time I needed them.

Counted, still standing, on [[journal/day-3628]]. Felled on day 3,648: see [[ogygia/build/timber-log]] and [[decisions/build-rather-than-wait]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/timber-log.md", "ogygia/_index.md", "journal/day-3628.md", "decisions/build-rather-than-wait.md"],
    fields: { species: 4, felled: 20 },
  },
  {
    path: "ogygia/island/shore.md",
    title: "The shore below the cave",
    type: "place",
    created: "2019-08-22",
    updated: "2026-07-11",
    status: "reference",
    tags: ["island", "shore"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "The one sand beach. Landed here on the keel; the raft sits at its tide line now.",
    body: `The only beach on the island that a boat could use: sand, sloping gently, sheltered from the north-west by the headland.

## Features
- Firm sand from the cave path down to the tide line.
- A rock shelf on the east end, good for sitting, bad for landing.
- The tide range is small, but the morning tide matters for getting a heavy hull off the sand without help ([[knowledge/beaching]]).

## Record of use
- Day 1,095: came ashore here on the keel ([[voyage/day-1095-ogygia]]).
- Most days of years two to six: sat on the shelf in the mornings. See [[journal/day-2914]] for one of them.
- Days 3,648 to 3,651: the building ground. The timber came down to the top of the beach; the raft was built there and levered to the tide line on the last afternoon on rollers.

## Today
The raft ([[voyage/ogygia/raft]]) is on its rollers at the waterline, stores partly aboard. The launch is planned for the turn of the tide at seven. It has not been made. See [[ogygia/build/departure-checklist]].

Filed under [[ogygia/_index]].`,
    links: ["journal/day-2914.md", "ogygia/build/departure-checklist.md", "ogygia/_index.md", "voyage/day-1095-ogygia.md", "knowledge/beaching.md", "voyage/ogygia/raft.md"],
    fields: { landings: 1, launches: 0 },
  },
  {
    path: "ogygia/island/headland.md",
    title: "The headland",
    type: "place",
    created: "2019-09-01",
    updated: "2026-06-30",
    status: "reference",
    tags: ["island", "shore"],
    places: ["place:ogygia"],
    summary: "High ground at the east end of the beach. Where I sit in the mornings and look east.",
    body: `The high ground at the east end of the beach. From the top the sea is open from north round to south-east, and on a clear day there is nothing in any of it.

## What it is for
- Watching for sails, years one to five. See [[ogygia/island/sightings]].
- Reading the weather before it reaches the cave. See [[ogygia/weather/seasons]] and [[studies/july-weather]].
- Sitting. Most mornings of seven years, from soon after sunrise until the heat comes on. The first was [[journal/day-1102]].

## What I record and what I do not
I record the wind and the sea from here. I do not record what I think about while I sit, because I tried in the first year and every entry was the same entry. The exception is [[journal/day-3100]].

> I have looked east from here more than two thousand mornings. Ithaca is east and north. The phone says so, and so does she.

Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/sightings.md", "ogygia/weather/seasons.md", "ogygia/_index.md", "studies/july-weather.md", "journal/day-1102.md", "journal/day-3100.md"],
    fields: { bearing_watched: "north to south-east", mornings: "about 2,300" },
  },
  {
    path: "ogygia/island/sightings.md",
    title: "Sails sighted",
    type: "log",
    created: "2019-07-18",
    updated: "2024-07-04",
    status: "closed",
    tags: ["island", "ships"],
    places: ["place:ogygia"],
    summary: "Forty-one sails in a little under five years, none closer than the horizon. Count closed in year five.",
    body: `A count of every sail seen from the headland, kept from day 1,101 until year five.

## Totals by year on the island
| Year | Sails | Closest | Signalled |
|---|---|---|---|
| 1 | 9 | Horizon | Fire, three times |
| 2 | 11 | Horizon | Fire, once |
| 3 | 8 | Horizon | No |
| 4 | 7 | Horizon | No |
| 5 (to day 2,914) | 6 | Horizon | No |
| **Total** | **41** | | |

## Method
A sail counted only if I saw it change position. Three possible sails in year one were cloud and are not counted.

## Signalling
The hearth smoke was the signal (see [[ogygia/island/hearth]]). Built up four times in the first two years. No ship turned. After year two I stopped building the fire for sails; the island is not on anybody's way to anywhere.

## Closed
Stopped counting in the fifth year, on day 2,914 or near it: [[journal/day-2914]] and [[journal/day-2920]]. Not restarted.

She had said as much in the first days: [[journal/day-1098]]. What ended the waiting instead: [[decisions/build-rather-than-wait]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/hearth.md", "journal/day-2914.md", "ogygia/_index.md", "journal/day-2920.md", "journal/day-1098.md", "decisions/build-rather-than-wait.md"],
    fields: { count: 41, closest: "horizon", status_note: "not restarted" },
  },
  {
    path: "ogygia/island/birds.md",
    title: "Birds of the wood",
    type: "note",
    created: "2020-03-10",
    updated: "2026-07-06",
    status: "reference",
    tags: ["island", "birds"],
    places: ["place:ogygia"],
    summary: "Owls, falcons and loud sea-crows nest in the wood. Logged by what they do, never interpreted.",
    body: `Long-winged birds roost in the wood round the cave: horned owls, falcons, and sea-crows with long tongues that work the shore all day and are never quiet.

## By behaviour
| Bird | What it does | When |
|---|---|---|
| Horned owl | Calls from the alders after dark | All year |
| Falcon | Hunts the meadow edge, stoops low | Mornings |
| Sea-crow | Works the tide line in groups, quarrels | All day |

## Policy
These are residents, not omens. A bird that lives here and does what it always does is weather, not a message. Omens are filed separately and only when a bird does something out of its pattern. None of the residents has ever been filed as one; at this revision the most recent omen, on day 3,646, was a hawk reported from Pylos ([[omens/day-3646-hawk]]).

## One practical note
The sea-crows go quiet before a blow from the south ([[knowledge/notus]]). In seven years I have not seen that fail, though I have also not tested it formally. Cross-referenced in [[ogygia/weather/seasons]].

Related: [[studies/signs-of-land]] and [[omens/heron-in-the-dark]]. Filed under [[ogygia/_index]].`,
    links: ["omens/day-3646-hawk.md", "ogygia/weather/seasons.md", "ogygia/_index.md", "knowledge/notus.md", "studies/signs-of-land.md", "omens/heron-in-the-dark.md"],
    fields: { species: 3, omens_from_residents: 0 },
  },

  /* ------------------------------------------------------------- routine */
  {
    path: "ogygia/routine/household.md",
    title: "The household day",
    type: "routine",
    created: "2019-10-01",
    updated: "2026-07-07",
    status: "superseded",
    tags: ["routine", "household"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "Seven years of the same day: water, wood, the headland, the meal, the fire. Suspended for the build.",
    body: `The household runs on one pattern, and it has hardly changed in seven years.

## The day
| Time | What |
|---|---|
| First light | Water from the first spring. Fire made up. |
| Morning | The headland, until the heat. |
| Late morning | Wood: splitting, carrying. Garden beds. |
| Midday | Eat. Rest in the cave. |
| Afternoon | She weaves and sings; I walk or mend. |
| Evening | The meal at the hearth. Talk. |
| Night | Sleep in the cave. |

## Who does what
- She runs the house. Nobody serves her; there are attendant women about the place who keep to themselves.
- I carry water and wood and keep out of the way of the loom.

## Status
Superseded on day 3,647, when the order came ([[ogygia/build/day-3647-the-order]], [[journal/day-3647]]). Days 3,648 to 3,651 ran to the build's pattern instead: dawn to dark at the woods and the shore.

See also [[ogygia/routine/meals]], [[ogygia/routine/loom]], and one ordinary morning: [[journal/day-2557]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/day-3647-the-order.md", "ogygia/routine/meals.md", "ogygia/routine/loom.md", "ogygia/_index.md", "journal/day-3647.md", "journal/day-2557.md"],
    fields: { since: 1130, until: 3647 },
  },
  {
    path: "ogygia/routine/meals.md",
    title: "What I eat",
    type: "routine",
    created: "2019-10-04",
    updated: "2026-07-11",
    status: "reference",
    tags: ["routine", "food"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "Bread, meat, wine, parsley and fruit, served by her attendants. Never hungry here. She eats different food.",
    body: `Two meals a day, both at the hearth.

## What is on the table
- Bread, every meal.
- Meat, most evenings.
- Wine from the cave stores, mixed with water.
- Wild parsley from the meadow, grapes in season from the vine.
- Cheese, olives, figs from the stores.

## What she eats
Not what I eat. Her attendants set ambrosia and nectar in front of her, and ordinary food in front of me. I have never asked to try hers, and I have been careful not to. A man who eats the food of the gods may stay where he eats it; the lotus ([[knowledge/lotus]]) taught the crew that much about strange food.

## Weight
Recovered my weight by about day 1,180 after the nine days adrift ([[voyage/legs/drift-to-ogygia]]). Have kept it since.

## Relevance now
Everything I eat for seventeen days after this morning comes out of one bag. See [[ogygia/stores/food-bag]] and [[studies/provisions-for-seventeen-days]]. The habit of being fed is the hardest one to plan around.

Filed under [[ogygia/_index]].`,
    links: ["ogygia/stores/food-bag.md", "ogygia/_index.md", "knowledge/lotus.md", "voyage/legs/drift-to-ogygia.md", "studies/provisions-for-seventeen-days.md"],
    fields: { meals_per_day: 2, shortages: 0 },
  },
  {
    path: "ogygia/routine/loom.md",
    title: "Her loom and her singing",
    type: "note",
    created: "2019-11-12",
    updated: "2026-07-11",
    status: "reference",
    tags: ["household", "loom"],
    people: ["person:calypso", "person:penelope"],
    places: ["place:calypso-cave"],
    summary: "She weaves at a great loom with a golden shuttle and sings while she works. The sail came off it.",
    body: `She works at a great loom in the main chamber, passing a golden shuttle, and sings while she does it. The singing is the sound of the cave in the afternoon for seven years.

## What comes off the loom
- Cloth for the household.
- The clothes she gave me in year one, and the clothes she has said she will give me this morning.
- The sail: she brought the cloth down to the beach on day 3,651 and I cut and hemmed it there. See [[ogygia/workshop/sail-cloth]].

## What I have noticed and not said
Every time I hear the shuttle I think of the other loom, the one at home. The news, when it came, said [[people/penelope]] was weaving a shroud ([[ithaca/loom/shroud]]) for my father and unpicking it at night, and had kept that up for three years until somebody counted ([[ithaca/loom/discovery]]). One loom is making a sail to take me away from it; the other was unmade every night to keep a household from being given away. I have not told Calypso about the other loom.

## Note to self
Thank her for the sail separately from thanking her for the rest. See [[ogygia/debts]].

The same thought on the headland: [[journal/day-3618]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/sail-cloth.md", "people/penelope.md", "ogygia/debts.md", "ogygia/_index.md", "ithaca/loom/shroud.md", "ithaca/loom/discovery.md", "journal/day-3618.md"],
    fields: { shuttle: "gold", source: "observed" },
  },
  {
    path: "ogygia/routine/day-count.md",
    title: "Keeping the count",
    type: "routine",
    created: "2019-07-22",
    updated: "2026-07-12",
    status: "active",
    tags: ["routine", "calendar"],
    places: ["place:ogygia"],
    summary: "The count of days since Troy, kept on the phone and checked against a cut on the cave post every tenth day.",
    body: `The day count since Troy is the one thing in the file I will not let drift. On the island there is nothing else to tell one day from the next.

## Method
1. The phone carries the count: day 0 is the day Troy fell ([[omens/aulis-serpent]]).
2. Every tenth day I cut a mark on the cedar post inside the cave mouth.
3. At each new moon I check the phone's count against the cuts.

## Discrepancies
| When | Found | Resolved |
|---|---|---|
| Year 1 | Cuts one short of phone | Missed a cut while ill. Phone correct. |
| Year 4 | None | |
| Year 6 | None | |

## Today
Day 3,652. Ten years since Troy to the day, seven years on this island (2,557 days). The post has 255 cuts and a scratch for the half-ten. I am not taking the post.

The count began on my fingers, adrift: [[voyage/day-1088-adrift]]. The journal entry for today is [[journal/day-3652]]. Filed under [[ogygia/_index]].`,
    links: ["journal/day-3652.md", "ogygia/_index.md", "omens/aulis-serpent.md", "voyage/day-1088-adrift.md"],
    fields: { day: 3652, days_on_island: 2557, cuts: 255 },
  },
  {
    path: "ogygia/routine/evenings.md",
    title: "Evenings at the hearth",
    type: "note",
    created: "2020-01-20",
    updated: "2026-07-11",
    status: "reference",
    tags: ["household", "routine"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "What we talk about at the fire, and the one subject that is not raised. Kept short on purpose.",
    body: `The evening meal, then talk at the fire until one of us goes in.

## What we talk about
- The island: the springs, the vine, the weather coming.
- Her father, Atlas, who holds the pillars that keep earth and sky apart. She speaks of him plainly.
- The war, when she asks. She asks less than she used to.
- Seamanship, from year six on. She knows the stars better than any pilot I sailed with.

## What is not raised
Leaving. It was raised every evening in the first year ([[journal/day-1130]]), then less, then not at all. Her position was settled in year two (see [[ogygia/the-offer]] and [[decisions/refuse-immortality]]) and mine was settled before I landed.

## The last four evenings
Days 3,648 to 3,651 were different. She came down to the beach in the evenings and looked at the work. On the last night she gave me the sailing directions at the fire, star by star: [[ogygia/build/sailing-directions]].

I am writing this down so that the evenings are on the record as well as the complaint. Both were true; see [[journal/day-3614]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/the-offer.md", "ogygia/build/sailing-directions.md", "ogygia/_index.md", "journal/day-1130.md", "decisions/refuse-immortality.md", "journal/day-3614.md"],
    fields: { evenings: "about 2,550" },
  },
  {
    path: "ogygia/routine/clothing.md",
    title: "Clothes",
    type: "inventory",
    created: "2019-07-15",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["household", "inventory"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "Landed in rags; dressed from her loom since. She has said there will be clothes for the crossing.",
    body: `Landed on day 1,095 ([[voyage/day-1095-ogygia]]) in what was left of what I wore off Thrinacia. She took that away on the second day and I did not ask for it back.

## What I have
| Item | Count | From |
|---|---|---|
| Tunic | 2 | Her loom |
| Cloak | 1 | Her loom |
| Belt | 1 | Her stores |
| Sandals | 1 pair | Her stores |

## For the crossing
She has said she will bathe me and give me fresh clothes this morning before the launch. Not yet done. Item stays open on [[ogygia/build/departure-checklist]].

## Risk noted
A heavy cloak is warmth at night and weight in the water. If the raft is lost, a man in a soaked cloak drowns faster than one without. I will take it and decide at sea. See [[studies/raft-versus-ship]].

Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/departure-checklist.md", "ogygia/_index.md", "voyage/day-1095-ogygia.md", "studies/raft-versus-ship.md"],
    fields: { count: 5, owner: "Calypso" },
  },

  /* ------------------------------------------------------------- workshop */
  {
    path: "ogygia/workshop/tools.md",
    title: "Tools lent",
    type: "inventory",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "on loan",
    tags: ["workshop", "tools"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "A bronze double axe, a polished adze and augers, lent for the build. To be returned before the launch.",
    body: `Every tool used on the raft came from her. In seven years I had none of my own ([[decisions/build-rather-than-wait]]).

| Tool | Count | Lent | Used for | Returned |
|---|---|---|---|---|
| Double axe, bronze, olive-wood haft | 1 | Day 3,648 | Felling, trimming | Not yet |
| Adze, polished | 1 | Day 3,648 | Squaring, smoothing | Not yet |
| Augers | 3 | Day 3,649 | Boring the logs for pegs | Not yet |

## Records
- [[ogygia/workshop/double-axe]]
- [[ogygia/workshop/adze]]
- [[ogygia/workshop/augers]]

## Return
All three back to the cave before I go down to the beach this morning. They are not mine and a raft has no use for an axe that I cannot replace if it goes over the side. Tracked on [[ogygia/workshop/tool-return]].

Related: [[journal/day-3648]] and [[knowledge/raft-construction]]. Filed under [[ogygia/_index]]; owner [[people/calypso]].`,
    links: ["ogygia/workshop/double-axe.md", "ogygia/workshop/adze.md", "ogygia/workshop/augers.md", "ogygia/workshop/tool-return.md", "ogygia/_index.md", "people/calypso.md", "decisions/build-rather-than-wait.md", "journal/day-3648.md", "knowledge/raft-construction.md"],
    fields: { count: 5, owner: "Calypso", returned: 0 },
  },
  {
    path: "ogygia/workshop/double-axe.md",
    title: "The double axe",
    type: "note",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "on loan",
    tags: ["workshop", "tools"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "A great bronze axe, sharp on both edges, with a fine olive-wood haft fitted tight. Felled all twenty trees.",
    body: `Handed to me at the cave on the morning of day 3,648 ([[journal/day-3648]]).

## Description
- Head: bronze, double-edged, both edges honed. Heavy enough to do the work with the weight rather than the arm.
- Haft: olive wood, close-grained, fitted tight through the eye. Did not work loose in four days.
- Fits the hand. Somebody made it for a big man.

## Work done with it
- Day 3,648: felled twenty trees and trimmed them (see [[ogygia/build/timber-log]]).
- Day 3,649: rough-squared the logs before the adze.
- Day 3,651: cut the mast and yard to length.

## Condition
Edges dulled on day 3,649 on a knot in poplar no. 18. Honed that evening on a stone from the shore. No nicks. Haft sound.

## Return
To go back to the cave this morning, cleaned and dry. On [[ogygia/workshop/tool-return]].

The decision it served: [[decisions/build-rather-than-wait]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/timber-log.md", "ogygia/workshop/tool-return.md", "ogygia/_index.md", "journal/day-3648.md", "decisions/build-rather-than-wait.md"],
    fields: { material: "bronze", haft: "olive wood", count: 1 },
  },
  {
    path: "ogygia/workshop/adze.md",
    title: "The adze",
    type: "note",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "on loan",
    tags: ["workshop", "tools"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "A polished adze that took every log straight to the line. The reason the hull fits.",
    body: `Lent with the axe on day 3,648.

## What it did
The axe brings a tree down. The adze makes it into timber. Every one of the twenty logs was dressed with it, and the faces were taken straight to a line snapped with a chalked cord so that log sat against log with no gap a wave could open.

## Use by day
| Day | Work |
|---|---|
| 3,648 | Trimming branches off the felled stems, late afternoon. |
| 3,649 | Squaring and smoothing all twenty, the whole day. |
| 3,650 | Dressing the deck planks and the gunwales. |
| 3,651 | Shaping the steering-oar blade. |

## Note
The blade is polished, not only sharp. It leaves a surface that sheds water. I have used adzes in the shipyards at home and none was this good.

## Return
On [[ogygia/workshop/tool-return]]. See also [[ogygia/build/planks]], [[journal/day-3649]] and [[knowledge/raft-construction]].

Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/tool-return.md", "ogygia/build/planks.md", "ogygia/_index.md", "journal/day-3649.md", "knowledge/raft-construction.md"],
    fields: { count: 1, owner: "Calypso" },
  },
  {
    path: "ogygia/workshop/augers.md",
    title: "The augers",
    type: "note",
    created: "2026-07-09",
    updated: "2026-07-11",
    status: "on loan",
    tags: ["workshop", "tools"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Three augers she brought down on the second day. Every log was bored and pegged with them.",
    body: `She brought the augers down to the beach on the morning of day 3,649, once the logs were down and trimmed.

## Count and use
| Auger | Bore | Used for |
|---|---|---|
| Large | Wide | Through-holes for the main pegs joining the bottom logs. |
| Medium | Middle | Rib and deck-beam joints. |
| Small | Narrow | Fixings for the gunwales and the wicker posts. |

## Method
Bore through two logs laid together, drive a hardwood peg, cut it flush. Then the next pair. The bottom is twenty logs' worth of this; the holes were counted by the pegs used, not separately.

## Wear
Large auger's cutting lip blunted by the end of day 3,649. Usable but slower. Recorded so that the return is honest about it.

## Return
On [[ogygia/workshop/tool-return]]. The jointing is described in [[ogygia/build/day-3649-squaring]] and [[journal/day-3649]]; the method in general at [[knowledge/raft-construction]].

Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/tool-return.md", "ogygia/build/day-3649-squaring.md", "ogygia/_index.md", "journal/day-3649.md", "knowledge/raft-construction.md"],
    fields: { count: 3, condition: "large one blunted" },
  },
  {
    path: "ogygia/workshop/tool-return.md",
    title: "Return the tools",
    type: "checklist",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["workshop", "tools", "checklist"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "Everything borrowed goes back to the cave before I go down to the raft. Nothing done yet this morning.",
    body: `Borrowed, used and to be returned. She did not ask for this list. I want it kept.

## Before going down to the beach
- [ ] Double axe: clean, dry, edge honed. See [[ogygia/workshop/double-axe]].
- [ ] Adze: clean, dry. See [[ogygia/workshop/adze]].
- [ ] Augers, all three: wiped, lips oiled. Tell her the large one is blunted. See [[ogygia/workshop/augers]].
- [ ] Chalk cord: back to the stores.
- [ ] Spare pegs: leave at the cave, not aboard.

## Not returnable
- The sail cloth. It is the sail now. Logged as a debt: [[ogygia/debts]]; see [[knowledge/guest-gifts]].
- The rope. Rigged.
- Twenty trees ([[decisions/build-rather-than-wait]]).

## Decision on keeping the axe
Considered asking to keep the axe for the crossing, for repairs. Decided not: it is hers, it is heavy, and a man on a raft who needs an axe has a problem the axe will not solve. Listed on [[ogygia/stores/not-taking]].

Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/double-axe.md", "ogygia/workshop/adze.md", "ogygia/workshop/augers.md", "ogygia/debts.md", "ogygia/stores/not-taking.md", "ogygia/_index.md", "knowledge/guest-gifts.md", "decisions/build-rather-than-wait.md"],
    fields: { count: 5, done: 0 },
  },
  {
    path: "ogygia/workshop/sail-cloth.md",
    title: "Sail cloth",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "done",
    tags: ["workshop", "rigging"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Cloth she brought from her own loom on day 3,651. Cut, hemmed, roped and bent on to the yard by dark.",
    body: `She brought the cloth down to the beach on the fourth day, day 3,651. It came off her own loom ([[ogygia/routine/loom]]) and it is better cloth than any sail I have stood under.

## Work
1. Laid out on the clean sand above the tide line.
2. Cut to the yard's length and a drop to suit the mast.
3. Hemmed all round. Double hem along the foot.
4. Rope sewn along the head and the foot. See [[ogygia/workshop/cordage]].
5. Bent on to the yard.

## Size
Square sail, a little wider than it is deep. Cut to be handled by one man, which is smaller than a ship of the fleet would carry. See [[studies/sail-handling-alone]].

## Reefing
No reef points. If it blows, the sail comes down altogether. Recorded as a known limit.

## Status
Bent on to the yard by dark on day 3,651, furled. Not yet hoisted at sea. The mast and yard are in [[ogygia/build/mast-and-yard]].

The day: [[journal/day-3651]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/routine/loom.md", "ogygia/workshop/cordage.md", "ogygia/build/mast-and-yard.md", "ogygia/_index.md", "studies/sail-handling-alone.md", "journal/day-3651.md"],
    fields: { day: 3651, source: "Calypso's loom", reefs: 0 },
  },
  {
    path: "ogygia/workshop/cordage.md",
    title: "Ropes",
    type: "inventory",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "done",
    tags: ["workshop", "rigging"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Braces, halyard and sheets, from her stores. Every line on the raft and what it does.",
    body: `All rope came from the cave stores, laid twisted fibre, sound.

| Line | Count | Does |
|---|---|---|
| Halyard | 1 | Hoists the yard up the mast. |
| Braces | 2 | Swing the yard to the wind, one each end. |
| Sheets | 2 | Hold the foot of the sail, one each corner. |
| Stays | 2 | Hold the mast fore and aft ([[knowledge/mast-stepping]]). |
| Lashings | Many | Steering oar, stores, wicker. |
| Spare coil | 1 | Kept aboard. |

## Rigged
All rigged on day 3,651 and tried by hand on the beach: yard hoisted and lowered twice, braced round both ways. The halyard runs free.

## For one man
Every line leads to within reach of the steering oar. If I have to let go of the oar to reach a line, the raft turns broadside. That was the rule for where every line ends. See [[studies/sail-handling-alone]].

See [[ogygia/workshop/sail-cloth]], [[ogygia/build/steering-oar]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/sail-cloth.md", "ogygia/build/steering-oar.md", "ogygia/_index.md", "knowledge/mast-stepping.md", "studies/sail-handling-alone.md"],
    fields: { count: 9, source: "Calypso's stores" },
  },

  /* ---------------------------------------------------------------- build */
  {
    path: "ogygia/build/day-3647-the-order.md",
    title: "Day 3,647 -- the order",
    type: "log",
    created: "2026-07-07",
    updated: "2026-07-07",
    status: "closed",
    tags: ["build", "order"],
    people: ["person:calypso", "person:athena"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Hermes came from Zeus with the order to let me go. She came down to the headland and said so, and swore not to harm me.",
    body: `## What happened
- Morning: [[people/hermes]] came to the cave with an order from [[people/zeus]]. I was on the headland and did not see him; this is as she told it.
- The order: let me go, now. Not with a ship or a crew; on something I build myself.
- Afternoon: she came down to the headland and told me I could go, and that she would help.

## What I asked for
An oath ([[decisions/accept-calypso-release]]). I said I would not set foot on a raft on her word alone, since a raft is a hard way to cross the sea and she might mean me harm by it. She laughed, and swore it: by earth, by the sky above, and by the water of the Styx, that she plans no harm to me. Filed at [[oaths/calypso-no-harm]].

## Who moved this
Not her, and not me. The council. I understand from what Hermes said to her that [[people/athena]] raised it. I have no way to thank anyone for it.

## Next
Tools tomorrow at first light. Plan the build tonight: [[ogygia/build/plan]].

The journal entry: [[journal/day-3647]]. Filed under [[ogygia/_index]]. The goal it serves: [[goals/return-to-ithaca]].`,
    links: ["oaths/calypso-no-harm.md", "people/athena.md", "ogygia/build/plan.md", "ogygia/_index.md", "goals/return-to-ithaca.md", "people/hermes.md", "people/zeus.md", "decisions/accept-calypso-release.md", "journal/day-3647.md"],
    fields: { day: 3647, source: "Calypso", oath: "by the Styx" },
  },
  {
    path: "ogygia/build/plan.md",
    title: "Build plan",
    type: "plan",
    created: "2026-07-07",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "plan"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Four days, twenty trees, one man. Written the night of the order and kept to almost exactly.",
    body: `Written by the fire on day 3,647, after the order and her oath ([[oaths/calypso-no-harm]]).

## Constraints
- One man. No crew to carry, haul or hold.
- Her tools, from tomorrow.
- Dry standing timber at the far end of the island.
- No time stated, but nobody rewrites an order from Zeus twice. Plan short.

## Plan against actual
| Day | Planned | Actual |
|---|---|---|
| 3,648 | Fell and trim twenty trees | Done. [[ogygia/build/day-3648-felling]] |
| 3,649 | Square, bore and peg the bottom | Done. [[ogygia/build/day-3649-squaring]] |
| 3,650 | Ribs, deck, gunwales, bulwarks | Done. [[ogygia/build/day-3650-deck]] |
| 3,651 | Mast, yard, oar, sail, rope; to the tide line | Done. [[ogygia/build/day-3651-rigging]] |
| 3,652 | Stores aboard; launch planned on the seven o'clock tide | In progress. [[ogygia/build/departure-checklist]] |

## Design
A raft, not a ship: no keel to build, no planked hull to caulk. But broad, decked, and fenced high, so that it behaves like a ship in a sea. See [[ogygia/build/dimensions]], and [[studies/raft-versus-ship]] for what a raft gives up.

Project record: [[voyage/ogygia/_index]]; the decision: [[decisions/build-rather-than-wait]]. Filed under [[ogygia/_index]].`,
    links: ["oaths/calypso-no-harm.md", "ogygia/build/day-3648-felling.md", "ogygia/build/day-3649-squaring.md", "ogygia/build/day-3650-deck.md", "ogygia/build/day-3651-rigging.md", "ogygia/build/departure-checklist.md", "ogygia/build/dimensions.md", "voyage/ogygia/_index.md", "ogygia/_index.md", "studies/raft-versus-ship.md", "decisions/build-rather-than-wait.md"],
    fields: { days_planned: 4, days_taken: 4 },
  },
  {
    path: "ogygia/build/timber-log.md",
    title: "Timber log",
    type: "ledger",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "timber"],
    places: ["place:ogygia"],
    summary: "Twenty trees: seven alder, six poplar, seven fir. Each one, and where it went.",
    body: `Twenty trees felled on day 3,648 at the far end of the island, all standing dry ([[journal/day-3648]]).

| No. | Species | Use |
|---|---|---|
| 1 | Fir | Mast |
| 2 | Fir | Yard |
| 3 | Fir | Steering oar and its post |
| 4 | Fir | Deck planks |
| 5 | Fir | Deck planks |
| 6 | Fir | Gunwales, port |
| 7 | Fir | Gunwales, starboard |
| 8 | Alder | Bottom log |
| 9 | Alder | Bottom log |
| 10 | Alder | Bottom log |
| 11 | Alder | Bottom log |
| 12 | Alder | Ribs |
| 13 | Alder | Ribs |
| 14 | Alder | Deck beams |
| 15 | Poplar | Bottom log |
| 16 | Poplar | Bottom log |
| 17 | Poplar | Bottom log |
| 18 | Poplar | Bottom log (knot; dulled the axe) |
| 19 | Poplar | Bottom log |
| 20 | Poplar | Rollers and levers for the launch |

## Totals
- Fir 7, alder 7, poplar 6. **Twenty.**
- Bottom: nine logs, alder and poplar, which float well dry.
- No cypress cut. The cypress round the cave is hers and live.

See [[ogygia/island/woods]], [[voyage/ogygia/raft]], [[decisions/build-rather-than-wait]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/woods.md", "voyage/ogygia/raft.md", "ogygia/_index.md", "journal/day-3648.md", "decisions/build-rather-than-wait.md"],
    fields: { count: 20, fir: 7, alder: 7, poplar: 6 },
  },
  {
    path: "ogygia/build/day-3648-felling.md",
    title: "Day 3,648 -- felling",
    type: "work-record",
    created: "2026-07-08",
    updated: "2026-07-08",
    status: "done",
    tags: ["build", "timber"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Twenty trees down and trimmed by dark. She showed me where the tallest stood and went back to the cave.",
    body: `## Morning
First light: she gave me the axe and the adze at the cave and walked me to the far end of the island, where the tallest trees stand. Showed me the stand and went home. Work began.

## Work
- Felled twenty trees: seven fir, seven alder, six poplar. List in [[ogygia/build/timber-log]].
- Trimmed every stem of its branches with the axe.
- Dressed the first faces with the adze where the light allowed.
- Dragged the shortest stems toward the beach path. The long firs stay where they fell until tomorrow.

## Count
| Item | Planned | Done |
|---|---|---|
| Trees felled | 20 | 20 |
| Trimmed | 20 | 20 |
| Moved | some | 6 |

## Notes
- The work went fast. Dry wood, a good axe, and seven years of rest in the arms.
- Hands blistered by midday; bound with cloth.
- No injury.

Tools: [[ogygia/workshop/double-axe]], [[ogygia/workshop/adze]]. Plan: [[ogygia/build/plan]]. Journal: [[journal/day-3648]]. The sneeze at the first tree: [[omens/day-3648-sneeze]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/timber-log.md", "ogygia/workshop/double-axe.md", "ogygia/workshop/adze.md", "ogygia/build/plan.md", "ogygia/_index.md", "journal/day-3648.md", "omens/day-3648-sneeze.md"],
    fields: { day: 3648, status_detail: "done", count: 20 },
  },
  {
    path: "ogygia/build/day-3649-squaring.md",
    title: "Day 3,649 -- squaring and pegging",
    type: "work-record",
    created: "2026-07-09",
    updated: "2026-07-09",
    status: "done",
    tags: ["build", "joinery"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Every log squared to the line, bored with her augers and pegged into one bottom. The raft has a floor.",
    body: `## Work
1. Hauled the remaining logs to the top of the beach.
2. Squared and smoothed all twenty with the adze, straight to a chalked line.
3. She brought the augers at mid-morning. See [[ogygia/workshop/augers]].
4. Laid the nine bottom logs side by side on skids, bored through in pairs, and drove hardwood pegs.
5. Cut a cross-piece at each end and pegged it across the whole bottom.

## Count
| Item | Done |
|---|---|
| Logs squared | 20 |
| Bottom logs laid | 9 |
| Bottom pegged | Yes |
| End cross-pieces | 2 |

## Problems
- Poplar no. 18 had a knot that took the edge off the axe. Honed in the evening.
- Large auger blunted by the end of the day.

## Check
Stood on the pegged bottom and jumped. No movement between logs. A wave will be a harder test.

Next: [[ogygia/build/day-3650-deck]]. Plan: [[ogygia/build/plan]]. Journal: [[journal/day-3649]]. Method: [[knowledge/raft-construction]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/augers.md", "ogygia/build/day-3650-deck.md", "ogygia/build/plan.md", "ogygia/_index.md", "journal/day-3649.md", "knowledge/raft-construction.md"],
    fields: { day: 3649, count: 9 },
  },
  {
    path: "ogygia/build/day-3650-deck.md",
    title: "Day 3,650 -- ribs, deck and bulwarks",
    type: "work-record",
    created: "2026-07-10",
    updated: "2026-07-10",
    status: "done",
    tags: ["build", "deck"],
    places: ["place:ogygia"],
    summary: "Ribs set close, deck beams across them, long planks laid as gunwales, and a wicker fence all round against the waves.",
    body: `## Work
- Set the ribs close together on the bottom, pegged.
- Laid the deck beams across the ribs and fitted the deck.
- Ran long planks along each side as gunwales. See [[ogygia/build/ribs-and-deck]].
- Cut osier withes and wove a wicker fence along both sides, the full length, to keep out the sea. See [[ogygia/build/bulwarks]].
- Heaped brushwood in along the wicker and stowed shore stones low amidships. See [[ogygia/stores/ballast]].

## Count
| Item | Done |
|---|---|
| Ribs | 12 |
| Deck beams | 7 |
| Deck | Laid |
| Gunwales | 2 |
| Wicker fence | Both sides |

## Notes
- The longest day of the four. Worked until I could not see the pegs.
- She came down at dusk and walked the deck once, end to end, and said it would do.

Journal: [[journal/day-3650]]; that night, [[omens/day-3650-the-bear]]. Next: [[ogygia/build/day-3651-rigging]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/ribs-and-deck.md", "ogygia/build/bulwarks.md", "ogygia/stores/ballast.md", "ogygia/build/day-3651-rigging.md", "ogygia/_index.md", "journal/day-3650.md", "omens/day-3650-the-bear.md"],
    fields: { day: 3650, ribs: 12, beams: 7 },
  },
  {
    path: "ogygia/build/day-3651-rigging.md",
    title: "Day 3,651 -- mast, sail and the water's edge",
    type: "work-record",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "rigging"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Mast stepped, yard fitted, steering oar shipped, sail cut from her cloth and bent on. Levered down to the tide line by dark.",
    body: `## Work
1. Stepped the mast and wedged it; yard fitted to it. See [[ogygia/build/mast-and-yard]] and [[knowledge/mast-stepping]].
2. Shaped and shipped the steering oar. See [[ogygia/build/steering-oar]].
3. She brought the sail cloth at midday. Cut, hemmed and roped it on the sand. See [[ogygia/workshop/sail-cloth]].
4. Rigged halyard, braces and sheets. See [[ogygia/workshop/cordage]].
5. Laid poplar rollers down the beach and levered the raft to the tide line.

## Count
| Item | Done |
|---|---|
| Mast | Stepped |
| Yard | Fitted, hoisted on trial twice |
| Steering oar | Shipped |
| Sail | Bent on, furled |
| At tide line | Yes |
| Floated | No |

## Status
The raft is built. Four days, as planned. It sits on its rollers at the water's edge, and the first tide it will float on is tomorrow morning's.

Also today: an eagle, reported second-hand from home ([[omens/day-3651-eagle]]). Filed, not interpreted.

The finished raft: [[voyage/ogygia/raft]]. Journal: [[journal/day-3651]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/mast-and-yard.md", "ogygia/build/steering-oar.md", "ogygia/workshop/sail-cloth.md", "ogygia/workshop/cordage.md", "omens/day-3651-eagle.md", "voyage/ogygia/raft.md", "ogygia/_index.md", "knowledge/mast-stepping.md", "journal/day-3651.md"],
    fields: { day: 3651, floated: false },
  },
  {
    path: "ogygia/build/planks.md",
    title: "Planks",
    type: "note",
    created: "2026-07-10",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "timber"],
    places: ["place:ogygia"],
    summary: "Deck planks split and adzed from two firs; gunwale planks from two more. How they were cut and fixed.",
    body: `## Source
Firs no. 4 and 5 for the deck; nos. 6 and 7 for the gunwales. See [[ogygia/build/timber-log]].

## Method
- Split along the grain with wedges cut from the offcuts, then adzed flat.
- No saw. The planks are thicker than a shipyard would cut, because splitting cannot be controlled finer than that.
- Each plank pegged to every beam it crosses with the small auger.

## Count
| Plank | Count | Source |
|---|---|---|
| Deck | 14 | Firs 4, 5 |
| Gunwale, each side | 2 | Firs 6, 7 |

## Fit
Gaps between deck planks are narrow enough that a foot will not catch. Water will come up through them in a sea; the deck is to stand on, not to keep water out. Keeping water out is the job of the wicker and the bottom.

Adze: [[ogygia/workshop/adze]]. Related: [[journal/day-3650]] and [[knowledge/raft-construction]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/timber-log.md", "ogygia/workshop/adze.md", "ogygia/_index.md", "journal/day-3650.md", "knowledge/raft-construction.md"],
    fields: { count: 18, saw: false },
  },
  {
    path: "ogygia/build/ribs-and-deck.md",
    title: "Ribs and deck",
    type: "note",
    created: "2026-07-10",
    updated: "2026-07-10",
    status: "done",
    tags: ["build", "deck"],
    places: ["place:ogygia"],
    summary: "Twelve ribs set close, seven deck beams fitted to them, and the deck laid over. A floor raised clear of the bottom.",
    body: `The bottom logs float. The deck is what keeps a man out of the water that will wash across them.

## Structure, from the bottom up
1. Nine bottom logs, pegged. See [[ogygia/build/day-3649-squaring]].
2. Twelve ribs of alder, set close and pegged across the bottom.
3. Seven deck beams of alder across the ribs.
4. Fourteen fir planks on the beams. See [[ogygia/build/planks]].
5. Gunwales along both sides on the beam ends.

## Why ribs at all
A raft of logs alone flexes in a sea; the pegs work loose; the logs part. The ribs tie every bottom log to every other along its length. This is the part of the build that is a ship rather than a raft, and it took most of day 3,650. See [[studies/raft-versus-ship]].

## Height
The deck sits about a forearm above the bottom. Enough that a calm sea stays below my feet. See [[knowledge/bailing]].

Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/day-3649-squaring.md", "ogygia/build/planks.md", "ogygia/_index.md", "studies/raft-versus-ship.md", "knowledge/bailing.md"],
    fields: { ribs: 12, beams: 7, count: 19 },
  },
  {
    path: "ogygia/build/bulwarks.md",
    title: "Wicker bulwarks",
    type: "note",
    created: "2026-07-10",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "deck"],
    places: ["place:ogygia"],
    summary: "A fence of woven osier along both sides, the full length, to break the waves before they cross the deck.",
    body: `## What
A wicker fence along both sides of the raft, the whole length, woven from osier withes cut by the third spring.

## Why
A raft has almost no freeboard. Every wave that reaches it would cross the deck. A solid bulwark would catch the wave and could tear off; a woven one breaks the force and lets the water through slowly. This is old practice ([[knowledge/raft-construction]]) and it is right.

## Build
- Posts pegged into the gunwales at intervals, using the small auger.
- Withes woven between them, green, so they shrink tight as they dry.
- Height: to the knee standing on deck.
- Brushwood packed in behind at the foot. See [[ogygia/stores/ballast]].

## Limits
It will not stop a breaking sea. Nothing on a raft will ([[knowledge/bailing]]). It will stop the ordinary sea from taking the stores off the deck, which is what it is for.

Work record: [[ogygia/build/day-3650-deck]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/stores/ballast.md", "ogygia/build/day-3650-deck.md", "ogygia/_index.md", "knowledge/raft-construction.md", "knowledge/bailing.md"],
    fields: { material: "osier", height: "knee" },
  },
  {
    path: "ogygia/build/mast-and-yard.md",
    title: "Mast and yard",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "rigging"],
    places: ["place:ogygia"],
    summary: "Fir mast stepped through the deck into a block on the bottom; fir yard slung from it. Both cut short for one man.",
    body: `## Mast
- Fir no. 1, the straightest of the twenty.
- Stepped through the deck into a socket block pegged to the bottom logs, and wedged.
- Two stays, fore and aft. See [[ogygia/workshop/cordage]].
- Cut shorter than the tree allowed. A tall mast on a raft drives the head under in a gust.

## Yard
- Fir no. 2.
- Slung from the masthead by the halyard; braced each end.
- Long enough for the sail she gave; no longer.

## Trials, day 3,651
| Trial | Result |
|---|---|
| Yard hoisted | Clean, twice |
| Yard braced round | Both sides, free |
| Mast under load (hauling on a stay) | No movement at the step |

## Known weakness
The mast is wedged, not stepped in a keelson as a ship's would be ([[knowledge/mast-stepping]]). In a heavy sea it could work loose. Check the wedges every morning at sea. Lowering it alone: [[studies/sail-handling-alone]].

Sail: [[ogygia/workshop/sail-cloth]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/cordage.md", "ogygia/workshop/sail-cloth.md", "ogygia/_index.md", "knowledge/mast-stepping.md", "studies/sail-handling-alone.md"],
    fields: { mast: "fir no. 1", yard: "fir no. 2" },
  },
  {
    path: "ogygia/build/steering-oar.md",
    title: "Steering oar",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "steering"],
    places: ["place:ogygia"],
    summary: "One steering oar of fir, over the stern on a post, lashed. The only control the raft has.",
    body: `## Make
- Fir no. 3: blade adzed flat and thin at the end; loom left round for the hand.
- A post pegged at the stern, and the oar lashed to it so it swings.

## Use
Sitting at the stern with the oar under one arm, I can reach the sheets and braces without letting go. That was the rule: see [[ogygia/workshop/cordage]].

## Risks
| Risk | Response |
|---|---|
| Lashing chafes through | Spare coil aboard; check at every watch. |
| Oar lost overboard | None spare. A second fir would have cost a fifth day. |
| Asleep at the oar | Calypso's directions say do not let the stars out of sight. Sleep in short spells, lashed. |

## Note
I will be at this oar for seventeen days and nights with no relief. There is no second watch aboard. That is the whole of the risk in one line.

Related: [[knowledge/steering-oar]], [[studies/sleep-on-a-single-hand-crossing]] and [[decisions/keep-the-helm-nine-days]]. The raft: [[voyage/ogygia/raft]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/cordage.md", "voyage/ogygia/raft.md", "ogygia/_index.md", "knowledge/steering-oar.md", "studies/sleep-on-a-single-hand-crossing.md", "decisions/keep-the-helm-nine-days.md"],
    fields: { count: 1, spare: false },
  },
  {
    path: "ogygia/build/dimensions.md",
    title: "Dimensions",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "done",
    tags: ["build", "raft"],
    places: ["place:ogygia"],
    summary: "As broad as a builder marks out the floor of a wide merchant hull. Paced and recorded on the last evening.",
    body: `I made the raft as broad in the beam as a man skilled in carpentry marks out the floor of a wide merchant ship. That was the rule; the paces below are what came of it.

## Measured on day 3,651, by pacing
| Measure | Paces |
|---|---|
| Length overall | About 9 |
| Beam | About 4 |
| Deck above bottom | A forearm |
| Wicker above deck | To the knee |
| Mast above deck | About 4 men's height |

## Why so broad
A narrow raft rolls. A broad one sits flat, carries stores, and lets a man lie down without hanging over the side. The cost is speed. Seventeen days is the estimate at this beam; see [[studies/crossing-distance-and-margin]] and [[goals/return-to-ithaca]].

## Comparison
A ship of the fleet out of Troy was longer by a great deal and narrower. None of them survived ([[crew/fleet-strength]]). I am recording that without drawing anything from it.

See [[voyage/ogygia/raft]] and [[ogygia/build/ribs-and-deck]]. Filed under [[ogygia/_index]].`,
    links: ["goals/return-to-ithaca.md", "voyage/ogygia/raft.md", "ogygia/build/ribs-and-deck.md", "ogygia/_index.md", "studies/crossing-distance-and-margin.md", "crew/fleet-strength.md"],
    fields: { length_paces: 9, beam_paces: 4 },
  },
  {
    path: "ogygia/build/launch-way.md",
    title: "Rollers and levers",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["build", "launch"],
    places: ["place:ogygia"],
    summary: "Poplar rollers down the sand and two levers. Got her to the tide line yesterday; the last few feet are for this morning.",
    body: `## Gear
- Rollers: cut from poplar no. 20, five lengths. See [[ogygia/build/timber-log]].
- Levers: two, from the same stem.
- Skids: offcuts laid on the sand where it is soft.

## Method, one man
1. Lever the stern up; slide a roller under.
2. Lever forward; the raft rides the roller.
3. Take the roller that comes clear at the stern, carry it to the bow. Repeat.

## Progress
- Day 3,651: from the top of the beach to the tide line before dark.
- Day 3,652 (today): the last stretch into the water on the turn of the tide at seven. Not yet done.

## Checks before the last lever
- [ ] Stores lashed. See [[ogygia/stores/provisions-aboard]].
- [ ] Steering oar lashed up out of the sand.
- [ ] Bow line ashore to a rock until she floats.

The rollers stay on the beach. Related: [[knowledge/beaching]] and [[journal/day-3651]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/timber-log.md", "ogygia/stores/provisions-aboard.md", "ogygia/_index.md", "knowledge/beaching.md", "journal/day-3651.md"],
    fields: { rollers: 5, levers: 2 },
  },
  {
    path: "ogygia/build/sailing-directions.md",
    title: "Sailing directions",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "active",
    tags: ["build", "navigation"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:scheria"],
    summary: "Calypso's directions, given at the fire on the last night: keep the Great Bear on the left hand, sail east of north.",
    body: `Given by her at the fire on day 3,651, star by star. Transcribed this morning from a voice memo.

> Keep the Great Bear on your left hand all the way. It is the one that turns in its place and watches Orion and never bathes in the sea.

## The stars to watch
| Star | Use |
|---|---|
| The Pleiades | Rising early; a check on the hour |
| Late-setting Bootes | Follows the Bear; confirms the course |
| The Great Bear | On the left hand, always. The course. |
| Orion | Across from the Bear; do not steer by it. |

## Course
East of north. The landfall planned is Scheria: seventeen days of open water, due on 29 July if nothing changes. Not seen; never been there.

## Rules she gave
- Do not let sleep close the eyes while the stars are up.
- Do not correct the course at night against a feeling.

The best directions in the file. Adopted as [[decisions/sail-by-the-bear]]; worked into numbers at [[studies/steering-by-the-bear]]; the stars at [[knowledge/great-bear]] and [[knowledge/pleiades]]. Planned route: [[goals/return-to-ithaca]]. Host: [[people/calypso]]. Filed under [[ogygia/_index]].`,
    links: ["goals/return-to-ithaca.md", "people/calypso.md", "ogygia/_index.md", "decisions/sail-by-the-bear.md", "studies/steering-by-the-bear.md", "knowledge/great-bear.md", "knowledge/pleiades.md"],
    fields: { source: "Calypso", course: "east of north", days: 17 },
  },
  {
    path: "ogygia/build/departure-checklist.md",
    title: "Departure morning",
    type: "checklist",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["build", "launch", "checklist"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Everything between now and the seven o'clock tide. The build is done; the morning's list is mostly open.",
    body: `Checked at 06:40. Tide turns at seven. Wind at first light: [[omens/day-3652-dawn-wind]].

## Done
- [x] Twenty trees felled and squared ([[ogygia/build/timber-log]])
- [x] Deck laid, bulwarks fitted ([[ogygia/build/day-3650-deck]])
- [x] Sail cut and bent on ([[ogygia/build/day-3651-rigging]])
- [x] Raft at the tide line on rollers
- [x] Sailing directions recorded ([[ogygia/build/sailing-directions]])

## Open
- [ ] Water: one skin aboard. Review the shortfall: [[ogygia/stores/water]], [[studies/water-ration]]
- [ ] Bag of bread and relishes aboard ([[ogygia/stores/food-bag]])
- [ ] Second skin of wine: not yet
- [ ] Clothes from her; bathe first ([[ogygia/routine/clothing]])
- [ ] Tools back to the cave ([[ogygia/workshop/tool-return]])
- [ ] Stores lashed; ballast checked ([[ogygia/stores/ballast]])
- [ ] Last stretch into the water ([[ogygia/build/launch-way]])
- [ ] Say goodbye properly ([[ogygia/debts]])

## Not on this list
Anything after the raft floats. That is a different record and it has not been opened.

Project: [[voyage/ogygia/_index]]; the decision: [[decisions/leave-today]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/timber-log.md", "ogygia/build/day-3650-deck.md", "ogygia/build/day-3651-rigging.md", "ogygia/build/sailing-directions.md", "ogygia/stores/water.md", "ogygia/stores/food-bag.md", "ogygia/routine/clothing.md", "ogygia/workshop/tool-return.md", "ogygia/stores/ballast.md", "ogygia/build/launch-way.md", "ogygia/debts.md", "voyage/ogygia/_index.md", "ogygia/_index.md", "omens/day-3652-dawn-wind.md", "studies/water-ration.md", "decisions/leave-today.md"],
    fields: { checked_at: "06:40", tide: "07:00", open: 8, done: 5 },
  },

  /* --------------------------------------------------------------- stores */
  {
    path: "ogygia/stores/provisions-aboard.md",
    title: "Provisions aboard",
    type: "inventory",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["stores", "inventory"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "One skin of wine and one larger skin of water are aboard. The bag of food and a second wine skin are not yet.",
    body: `Everything that will feed and water one man for seventeen days ([[studies/provisions-for-seventeen-days]]). All of it from her stores.

| Item | Count | Aboard | Note |
|---|---|---|---|
| Skin of wine | 1 | Yes | Strong; to be mixed. [[ogygia/stores/wine]] |
| Skin of water, the larger | 1 | Yes | Short. [[ogygia/stores/water]] |
| Bag of bread and relishes | 1 | Not yet | Packed at the cave. [[ogygia/stores/food-bag]] |
| Second skin of wine | 1 | Not yet | Offered; not yet carried down. |

## Stowage
Lashed amidships, low, against the mast step, inside the wicker on the windward side. Nothing on the deck edge.

## The shortfall
One skin of water for seventeen days does not close ([[studies/water-ration]]). This record does not try to close it: [[ogygia/stores/water]] holds the review.

What keeps at sea: [[knowledge/sea-provisions]]. On [[ogygia/build/departure-checklist]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/stores/wine.md", "ogygia/stores/water.md", "ogygia/stores/food-bag.md", "ogygia/build/departure-checklist.md", "ogygia/_index.md", "studies/provisions-for-seventeen-days.md", "studies/water-ration.md", "knowledge/sea-provisions.md"],
    fields: { count: 4, aboard: 2, source: "Calypso" },
  },
  {
    path: "ogygia/stores/water.md",
    title: "Water",
    type: "review",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "open",
    tags: ["stores", "water"],
    places: ["place:ogygia"],
    summary: "One skin, filled at the fourth spring. Seventeen days of sailing. The shortfall is open and under review.",
    body: `## Position
- Aboard: one skin, the larger of the two she gave, about 18 litres. Filled at the fourth spring on day 3,651. See [[ogygia/island/springs]].
- Required: seventeen days, one man, in summer, at work at an oar.

## The arithmetic, roughly
A careful man can live on less water than a working one. At a careful ration the one skin covers something like half the crossing; at a working ration less. The numbers are rough because the skin was measured with the cave's jug, not a measured jar. The gap is not rough; the worked numbers are in [[studies/water-ration]].

## Options under review
| Option | For | Against |
|---|---|---|
| Ask for two more jars, about 10 litres each | Closes more than half the gap | Weight; stowage; not yet aboard |
| Ration hard from day one | Costs nothing | Judgement goes first in thirst ([[knowledge/fevers]]) |
| Catch rain in the sail | Free | Summer; no rain for weeks ([[ogygia/weather/last-weeks]], [[studies/july-weather]]) |
| Wine, mixed thin | Already aboard | Not a substitute |

## Status
Open. Review the shortfall before the tide. Not resolved by writing it down. It is the open question on [[decisions/leave-today]].

On [[ogygia/build/departure-checklist]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/springs.md", "ogygia/weather/last-weeks.md", "ogygia/build/departure-checklist.md", "ogygia/_index.md", "knowledge/fevers.md", "studies/water-ration.md", "studies/july-weather.md", "decisions/leave-today.md"],
    fields: { count: 1, days_required: 17, confidence: "rough" },
  },
  {
    path: "ogygia/stores/wine.md",
    title: "Wine",
    type: "inventory",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["stores", "wine"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "One skin of strong wine aboard from her stores. A second offered and not yet carried down.",
    body: `## Aboard
One skin of wine, from the cave stores, strong. Lashed amidships on day 3,651.

## Not yet aboard
A second skin. She offered it last night. I have not yet carried it down. It stays open on [[ogygia/build/departure-checklist]].

## Use at sea
- Mixed with water, never neat. Neat wine and an open sea is how men fall overboard.
- A little at dusk; none on watch.
- Not counted as water. See [[ogygia/stores/water]].

## A note on strong wine
The last strong wine I carried was [[people/maron]]'s, from Ismarus ([[crew/ismarus-wine-ration]]). It is the reason a Cyclops slept ([[voyage/day-98-the-stake]]). I have not forgotten what that cost afterwards, and I have not forgotten that it worked.

Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/departure-checklist.md", "ogygia/stores/water.md", "ogygia/_index.md", "people/maron.md", "crew/ismarus-wine-ration.md", "voyage/day-98-the-stake.md"],
    fields: { count: 1, offered: 2 },
  },
  {
    path: "ogygia/stores/food-bag.md",
    title: "The food bag",
    type: "inventory",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["stores", "food"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "A leather bag of bread and relishes, packed by her attendants. At the cave, to go aboard this morning.",
    body: `## Contents, as packed
| Item | Note |
|---|---|
| Bread | Hard-baked, for keeping. |
| Relishes | Many: cheese, olives, dried figs, salted meat. |
| Barley meal | A small sack inside the bag. |

## Where it is
At the cave mouth, tied. Not yet aboard. On [[ogygia/build/departure-checklist]].

## Ration
Divide by seventeen and do not eat ahead of the day. The arithmetic: [[studies/provisions-for-seventeen-days]]. A man alone can lie to himself about a bag of food more easily than about a skin of water, because he can see the water going down.

## Stowage
In the lee of the mast step, inside the wicker, lashed twice. If it gets wet, the bread goes first ([[knowledge/sea-provisions]]).

Habit to break: [[ogygia/routine/meals]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/departure-checklist.md", "ogygia/routine/meals.md", "ogygia/_index.md", "studies/provisions-for-seventeen-days.md", "knowledge/sea-provisions.md"],
    fields: { count: 1, aboard: false, days: 17 },
  },
  {
    path: "ogygia/stores/ballast.md",
    title: "Ballast",
    type: "note",
    created: "2026-07-10",
    updated: "2026-07-12",
    status: "in progress",
    tags: ["stores", "ballast"],
    places: ["place:ogygia"],
    summary: "Brushwood heaped along the wicker, and shore stones stowed low amidships. One check left before the tide.",
    body: `## What is aboard
- Brushwood, heaped in along the foot of the wicker fence on both sides. Breaks the water coming through and keeps the stores off the wet deck ([[knowledge/bailing]]).
- Stones from the shore, stowed low amidships either side of the mast step, wedged between the ribs.

## Why
A raft rides on the top of the sea ([[studies/raft-versus-ship]]). Weight low and in the middle keeps her head steady and stops the mast swinging her over in a gust.

## Trim
| Check | Day 3,651 | Today |
|---|---|---|
| Level side to side | Yes, on the rollers | Check afloat |
| Bow and stern | Stern a little heavy (oar) | Shift one stone forward if needed |

## Open
- [ ] Recheck the trim once she floats, before the sail is set.

Built into the work of [[ogygia/build/day-3650-deck]]; see also [[ogygia/build/bulwarks]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/build/day-3650-deck.md", "ogygia/build/bulwarks.md", "ogygia/_index.md", "studies/raft-versus-ship.md", "knowledge/bailing.md"],
    fields: { material: "brushwood, stone" },
  },
  {
    path: "ogygia/stores/not-taking.md",
    title: "Things I will not take",
    type: "list",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "active",
    tags: ["stores", "decisions"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "What stays on the island, and why each one stays. Shorter than I expected.",
    body: `Decided on the last evening. Each item stays for a reason, written down so I do not reopen it at sea.

| Item | Reason |
|---|---|
| The axe, the adze, the augers | Hers. See [[ogygia/workshop/tool-return]]. |
| A cutting of the vine | It would die at sea, and it is hers. See [[ogygia/island/vine]]. |
| The cedar post with the cuts | The phone keeps the count. See [[ogygia/routine/day-count]]. |
| Spare timber | Weight. The rollers stay on the beach. |
| Anything from the inner chambers | Not offered. |
| What she offered in year two | Refused then; refused now. See [[ogygia/the-offer]] and [[decisions/refuse-immortality]]. |
| The count of sails | Closed. See [[ogygia/island/sightings]]. |

## What I am taking
Clothes she gives me, the stores she packed, the raft, the directions, and the phone. That is all.

## Note
Seven years, and the list of what I own at the end of it fits in one line. See [[knowledge/guest-gifts]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/workshop/tool-return.md", "ogygia/island/vine.md", "ogygia/routine/day-count.md", "ogygia/the-offer.md", "ogygia/island/sightings.md", "ogygia/_index.md", "decisions/refuse-immortality.md", "knowledge/guest-gifts.md"],
    fields: { count: 7 },
  },

  /* -------------------------------------------------------------- weather */
  {
    path: "ogygia/weather/last-weeks.md",
    title: "Weather log, the last four weeks",
    type: "log",
    created: "2026-06-14",
    updated: "2026-07-12",
    status: "active",
    tags: ["weather", "log"],
    places: ["place:ogygia"],
    summary: "Daily wind and sea from the headland, 14 June to this morning. North-westerlies all month; a southerly air since last night.",
    body: `Observed from the headland at first light, every other day, and every day of the build.

| Day | Date | Wind | Sea | Note |
|---|---|---|---|---|
| 3,624 | 14 Jun | NW, fresh | Moderate | Usual summer pattern |
| 3,626 | 16 Jun | NW, fresh | Moderate | |
| 3,628 | 18 Jun | NW, strong | Rough | Whitecaps to the horizon |
| 3,630 | 20 Jun | NW, fresh | Moderate | |
| 3,632 | 22 Jun | N, light | Slight | |
| 3,634 | 24 Jun | NW, fresh | Moderate | |
| 3,636 | 26 Jun | NW, fresh | Moderate | |
| 3,638 | 28 Jun | NW, strong | Rough | |
| 3,640 | 30 Jun | NW, moderate | Moderate | |
| 3,642 | 2 Jul | NW, moderate | Moderate | |
| 3,644 | 4 Jul | W, light | Slight | |
| 3,646 | 6 Jul | NW, moderate | Moderate | Hawk reported from Pylos; see [[omens/day-3646-hawk]] |
| 3,648 | 8 Jul | NW, light | Slight | Felling |
| 3,649 | 9 Jul | N, light | Slight | |
| 3,650 | 10 Jul | Calm, then NW | Slight | |
| 3,651 | 11 Jul | Calm; S air at dusk | Smooth | Rigging |
| 3,652 | 12 Jul, 06:40 | S, light | Slight | Launch planned |

## Reading
A month of north-westerlies, which would be against a course east of north ([[studies/wind-for-the-heading]]). A southerly air since last night is the first fair wind of the summer. One observation is not a pattern ([[omens/day-3652-dawn-wind]]).

No rain in four weeks. See [[ogygia/stores/water]] and [[studies/july-weather]]. Filed under [[ogygia/_index]].`,
    links: ["omens/day-3646-hawk.md", "ogygia/stores/water.md", "ogygia/_index.md", "studies/wind-for-the-heading.md", "omens/day-3652-dawn-wind.md", "studies/july-weather.md"],
    fields: { observations: 17, rain_days: 0, current_wind: "S, light" },
  },
  {
    path: "ogygia/weather/seasons.md",
    title: "Seven years of seasons",
    type: "reference",
    created: "2020-07-11",
    updated: "2026-06-30",
    status: "reference",
    tags: ["weather", "seasons"],
    places: ["place:ogygia"],
    summary: "The island's weather year, from seven years of headland notes. Summer north-westerlies, winter gales, rare southerlies.",
    body: `Compiled from the headland notes: loose ones from the first summer, a proper daily record from year five ([[ogygia/years/year-5]]). Revised each summer. July is drawn out in [[studies/july-weather]].

## The year on Ogygia
| Season | Wind | Sea | Sailing |
|---|---|---|---|
| High summer | NW, steady, fresh by afternoon | Moderate | Fair for southbound only |
| Late summer | NW easing; calms | Slight | Calms are the risk |
| Autumn | Variable; first gales | Building | Poor |
| Winter | Gales from N and S | Rough | None |
| Spring | Variable, settling | Moderate | Possible |

## Southerlies
Rare in summer: a handful each season, mostly gentle, mostly in the night or early morning. In seven years I logged twenty-three summer mornings with a southerly air. Most did not last the day. See [[knowledge/notus]].

## Signs that held
- The sea-crows go quiet before a blow from the south. See [[ogygia/island/birds]].
- A swell from the east with no wind means weather a day or two off.

## Signs that did not
- Cloud on the far end of the island. Means nothing.

Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/birds.md", "ogygia/_index.md", "studies/july-weather.md", "knowledge/notus.md", "ogygia/years/year-5.md"],
    fields: { years: 7, summer_southerlies: 23 },
  },
  {
    path: "ogygia/weather/launch-window.md",
    title: "The launch window",
    type: "review",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "open",
    tags: ["weather", "launch"],
    people: ["person:calypso", "person:poseidon"],
    places: ["place:ogygia", "place:scheria"],
    summary: "Southerly air this morning, slight sea, tide at seven. Fair as far as the eye goes, and the eye does not go seventeen days.",
    body: `## This morning, 06:40
- Wind: southerly, light. A following air for a course east of north.
- Sea: slight.
- Sky: clear. The Bear ([[knowledge/great-bear]]) stood in the north before dawn, where she said it would be.
- Tide: turns at seven.

## What she said
That she would send a wind behind me. I have recorded that she said it ([[omens/day-3652-dawn-wind]]). I have not recorded that it has happened, and this air is not proof either way.

## What is not known
| Unknown | Note |
|---|---|
| Weather after day three | No way to see it. |
| The grievance | [[people/poseidon]] has not withdrawn it, and the sea is his ([[studies/poseidon-risk]]). |
| Landfall | Scheria is a plan, 29 July, not a place I have seen. |

## Recommendation to self
Go on this tide ([[decisions/leave-today]]). The month's log ([[ogygia/weather/last-weeks]]) says north-westerlies come back; a southerly is not a thing to wait for twice.

Filed under [[ogygia/_index]].`,
    links: ["people/poseidon.md", "ogygia/weather/last-weeks.md", "ogygia/_index.md", "knowledge/great-bear.md", "omens/day-3652-dawn-wind.md", "studies/poseidon-risk.md", "decisions/leave-today.md"],
    fields: { wind: "S, light", sea: "slight", tide: "07:00" },
  },

  /* ---------------------------------------------------- the year summaries */
  {
    path: "ogygia/years/year-1.md",
    title: "Year one on Ogygia",
    type: "summary",
    created: "2020-07-11",
    updated: "2020-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Days 1,095 to 1,460. Recovered, surveyed the island, and learned there was no way off it.",
    body: `Days 1,095 to 1,460.

## What happened
- Landfall on the keel, alone: [[ogygia/island/day-1095-landfall]].
- Two months to recover the strength lost in nine days adrift ([[voyage/legs/drift-to-ogygia]]).
- Walked the island: no harbour, no hulls, no settlement. See [[ogygia/island/survey]].
- Asked to leave, most evenings. Refused, most evenings.
- Counted nine sails, none near. Built the signal fire three times.

## What I learned
- She is not keeping me with a lock. She is keeping me with the sea. There is no vessel and no tool, and an island with no traffic is a sufficient prison ([[journal/day-1098]]).
- The household is comfortable and is not going to change.

## Count
| Measure | Value |
|---|---|
| Days | 366 |
| Sails | 9 |
| Ways off | 0 |

## Carried forward
A way off. The year's end: [[journal/day-1460]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/day-1095-landfall.md", "ogygia/island/survey.md", "ogygia/_index.md", "voyage/legs/drift-to-ogygia.md", "journal/day-1098.md", "journal/day-1460.md"],
    fields: { year: 1, first_day: 1095, last_day: 1460 },
  },
  {
    path: "ogygia/years/year-2.md",
    title: "Year two on Ogygia",
    type: "summary",
    created: "2021-07-11",
    updated: "2021-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Days 1,461 to 1,825. The routine settled; the offer was made and refused.",
    body: `Days 1,461 to 1,825.

## What happened
- The household routine settled into the shape it kept for five more years: [[ogygia/routine/household]].
- She made the offer: stay, and never age, and never die. I refused. See [[ogygia/the-offer]], [[decisions/refuse-immortality]] and [[journal/day-1575]].
- Proposed a barley strip in the meadow; not needed. See [[ogygia/island/meadows]].
- Eleven sails. Signal fire built once. The last time.

## What I learned
- She means the offer. It is not a trick, which makes it harder to refuse, not easier.
- The headland in the mornings became the fixed point of the day.

## Count
| Measure | Value |
|---|---|
| Days | 365 |
| Sails | 11 |
| Offers refused | 1 |

## Carried forward
A way off, still. The asking stopped being every evening and became most evenings. The year's end: [[journal/day-1825]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/routine/household.md", "ogygia/the-offer.md", "ogygia/island/meadows.md", "ogygia/_index.md", "decisions/refuse-immortality.md", "journal/day-1575.md", "journal/day-1825.md"],
    fields: { year: 2, first_day: 1461, last_day: 1825 },
  },
  {
    path: "ogygia/years/year-3.md",
    title: "Year three on Ogygia",
    type: "summary",
    created: "2022-07-11",
    updated: "2022-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Days 1,826 to 2,190. Assessed the timber and drew a raft I had no tools to build.",
    body: `Days 1,826 to 2,190.

## What happened
- Walked the far end of the island tree by tree and marked the dry standing firs, alders and poplars. See [[ogygia/island/woods]].
- Drew a raft on the phone: a broad bottom, ribs, a deck, a fence of wicker ([[knowledge/raft-construction]]). Most of what was built four years later is in that drawing.
- Asked for an axe. Refused, without anger.
- Eight sails.
- The vine crop split in a late rain. See [[ogygia/island/vine]].

## What I learned
- The plan was never the problem. The tool was.
- A man can be in the right place with the right timber for four years and still not be able to cut one tree.

## Count
| Measure | Value |
|---|---|
| Days | 365 |
| Sails | 8 |
| Trees marked | 24 |
| Trees cut | 0 |

## Carried forward
The drawing. The year's end: [[journal/day-2190]]. Filed under [[ogygia/_index]].`,
    links: ["ogygia/island/woods.md", "ogygia/island/vine.md", "ogygia/_index.md", "knowledge/raft-construction.md", "journal/day-2190.md"],
    fields: { year: 3, first_day: 1826, last_day: 2190 },
  },
  {
    path: "ogygia/years/year-4.md",
    title: "Year four on Ogygia",
    type: "summary",
    created: "2023-07-11",
    updated: "2023-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Days 2,191 to 2,555. The worst year. Little written, most of it the same entry.",
    body: `Days 2,191 to 2,555.

## What happened
Very little, and that is the record. The headland every morning. The shore most afternoons. Seven sails. One piece of news, on day 2,400, the first from home to reach this island: men in my hall, courting her. See [[journal/day-2400]] and [[ithaca/timeline]].

I stopped writing the daily entry for long stretches this year. The gaps are not losses; there was nothing in them except sitting on the rock shelf looking at the sea and wanting to see the smoke going up from my own land, and then to die.

## What I learned
- The count of days held even when the entries did not. See [[ogygia/routine/day-count]].
- She noticed. She did not say anything about it, and she did not offer again.

## Count
| Measure | Value |
|---|---|
| Days | 365 |
| Sails | 7 |
| Journal gaps over ten days | 6 |

## Carried forward
Nothing new. The same want, a year older ([[journal/day-2555]]). Filed under [[ogygia/_index]]; the goal it has not moved is [[goals/return-to-ithaca]].`,
    links: ["journal/day-2400.md", "ogygia/routine/day-count.md", "ogygia/_index.md", "goals/return-to-ithaca.md", "ithaca/timeline.md", "journal/day-2555.md"],
    fields: { year: 4, first_day: 2191, last_day: 2555 },
  },
  {
    path: "ogygia/years/year-5.md",
    title: "Year five on Ogygia",
    type: "summary",
    created: "2024-07-11",
    updated: "2024-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Days 2,556 to 2,921. Stopped counting sails. Started keeping the island's weather properly instead.",
    body: `Days 2,556 to 2,921.

## What happened
- Six sails, none near. Stopped counting on or about day 2,914: [[journal/day-2914]], [[journal/day-2920]]. The sightings log is closed: [[ogygia/island/sightings]].
- Started keeping the weather properly from the headland, every morning, so that the mornings there would at least produce something. Until now it had been loose notes, kept since the first summer. See [[ogygia/weather/seasons]] and [[studies/july-weather]].
- Took over splitting all the hearth wood.

## What I learned
- Counting sails was a way of waiting for someone else to solve it. Nobody is coming. Whatever ends this will start on the island.
- The weather is worth knowing whether or not I ever sail in it.

## Count
| Measure | Value |
|---|---|
| Days | 366 |
| Sails (to day 2,914) | 6 |
| Weather observations | Daily from midyear |

## Carried forward
The weather record, which became the most useful thing I kept. Filed under [[ogygia/_index]].`,
    links: ["journal/day-2914.md", "ogygia/island/sightings.md", "ogygia/weather/seasons.md", "ogygia/_index.md", "journal/day-2920.md", "studies/july-weather.md"],
    fields: { year: 5, first_day: 2556, last_day: 2921 },
  },
  {
    path: "ogygia/years/year-6.md",
    title: "Year six on Ogygia",
    type: "summary",
    created: "2025-07-11",
    updated: "2025-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso", "person:penelope"],
    places: ["place:ogygia"],
    summary: "Days 2,922 to 3,286. Learned the stars from her. News of home, second-hand, did not make the waiting easier.",
    body: `Days 2,922 to 3,286.

## What happened
- She began, without being asked, to talk about the stars at the fire: which rise when, which never set ([[knowledge/great-bear]]), which to steer by. Every word is now in [[ogygia/build/sailing-directions]].
- Pruned the vine for the first time, under her instruction.
- What reached the file of home, through the year, was one second-hand report, about my father on his farm: [[ithaca/news/day-3221-laertes]]. Nothing more about [[people/penelope]] or the hall since the first word of them on day 2,400.

## What I learned
- Calypso knows the sea from above it. Her directions are better than any pilot's I sailed with.
- News without a way to act on it is a weight, not a help. I filed it all and did nothing, because there was nothing to do.

## Count
| Measure | Value |
|---|---|
| Days | 365 |
| Stars learned | 4 to steer by |
| Ways off | 0 |

## Carried forward
The stars. The year's end: [[journal/day-3285]]. Filed under [[ogygia/_index]].`,
    links: ["ithaca/news/day-3221-laertes.md", "ogygia/build/sailing-directions.md", "people/penelope.md", "ogygia/_index.md", "knowledge/great-bear.md", "journal/day-3285.md"],
    fields: { year: 6, first_day: 2922, last_day: 3286 },
  },
  {
    path: "ogygia/years/year-7.md",
    title: "Year seven on Ogygia",
    type: "summary",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "closed",
    tags: ["years", "summary"],
    people: ["person:calypso", "person:athena"],
    places: ["place:ogygia"],
    summary: "Days 3,287 to 3,651. Nothing changed for fifty weeks, and then everything did in five days.",
    body: `Days 3,287 to 3,651. Written on the last evening of it.

## What happened
- Fifty weeks of the same year as the last six.
- Day 3,646: reported from Pylos, a hawk crossing on the right of my son's ship, carrying. Filed without interpretation: [[omens/day-3646-hawk]].
- Day 3,647: the order came from Zeus, by [[people/hermes]]. She swore not to harm me: [[oaths/calypso-no-harm]]. See [[ogygia/build/day-3647-the-order]] and [[journal/day-3647]]. I understand [[people/athena]] raised it.
- Days 3,648 to 3,651: the raft. Twenty trees, four days. See [[ogygia/build/plan]] and [[decisions/build-rather-than-wait]].
- Day 3,651: an eagle, reported from home: [[omens/day-3651-eagle]].

## What I learned
- Seven years of waiting ended in an afternoon, and none of it was my doing.
- The build was easy. Every part of it had been planned for four years.

## Count
| Measure | Value |
|---|---|
| Days | 365 |
| Trees felled | 20 |
| Days building | 4 |
| Days on the island in all | 2,557 |

## Carried forward
The raft, the stores, the directions. Tomorrow is day 3,652. Filed under [[ogygia/_index]].`,
    links: ["oaths/calypso-no-harm.md", "omens/day-3646-hawk.md", "ogygia/build/day-3647-the-order.md", "people/athena.md", "ogygia/build/plan.md", "omens/day-3651-eagle.md", "ogygia/_index.md", "people/hermes.md", "journal/day-3647.md", "decisions/build-rather-than-wait.md"],
    fields: { year: 7, first_day: 3287, last_day: 3651 },
  },

  /* ------------------------------------------------------- her, and debts */
  {
    path: "ogygia/the-offer.md",
    title: "The offer",
    type: "decision",
    created: "2020-11-03",
    updated: "2026-07-11",
    status: "closed",
    tags: ["decisions", "calypso"],
    people: ["person:calypso", "person:penelope"],
    places: ["place:calypso-cave"],
    summary: "She offered to make me immortal and ageless if I stayed. Refused. Recorded with what the refusal costs.",
    body: `## The offer
Made at the hearth on day 1,575, in year two, in plain words: stay here, keep this house with me, and I will make you deathless and ageless all your days.

## The options
| Option | Gives | Costs |
|---|---|---|
| Accept | No death, no age, this island, her | Ithaca, [[people/penelope]], my son, my father, my name |
| Refuse | The chance of going home | The rest of a mortal life, spent mostly here, possibly ending at sea |

## Decision
Refused, the same evening ([[journal/day-1575]]). I told her the truth: that Penelope is less than she is in looks and stature, being mortal, and that I want to go home anyway, and see the day of my return, and if some god wrecks me on the way I will bear it.

## Standing
Closed. She has not made the offer again. On the night of day 3,647 she asked once more whether I was sure, and I said I was.

## Still worth recording
That I did not refuse it lightly. Filed under [[ogygia/_index]]; see [[ogygia/stores/not-taking]] and [[decisions/refuse-immortality]].`,
    links: ["people/penelope.md", "ogygia/_index.md", "ogygia/stores/not-taking.md", "journal/day-1575.md", "decisions/refuse-immortality.md"],
    fields: { decision: "refused", day: 1575, reopened: false },
  },
  {
    path: "ogygia/debts.md",
    title: "What I owe Calypso",
    type: "ledger",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "open",
    tags: ["calypso", "ledger"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Seven years of food and shelter, tools, timber, cloth, rope, directions and an oath. None of it repayable.",
    body: `A ledger with one column. I have nothing to put against any of it.

| Owed | Note |
|---|---|
| My life, day 1,095 | Taken in off the keel half dead. [[ogygia/island/day-1095-landfall]] |
| Food and shelter, 2,557 days | Never short. [[ogygia/routine/meals]] |
| Clothes | Off her loom. [[ogygia/routine/clothing]] |
| Tools, four days | Being returned. [[ogygia/workshop/tool-return]] |
| Twenty trees | From her island. [[ogygia/build/timber-log]] |
| The sail cloth | Off her loom. [[ogygia/workshop/sail-cloth]] |
| Rope | From her stores. [[ogygia/workshop/cordage]] |
| The stores aboard | [[ogygia/stores/provisions-aboard]] |
| Sailing directions | The best in the file. [[ogygia/build/sailing-directions]] |
| An oath, day 3,647 | That she plans no harm. Asked for by me. [[oaths/calypso-no-harm]], [[decisions/accept-calypso-release]] |

## On the other side
She kept me seven years against my will. That is also true and it is not on this ledger, because it does not cancel anything on it. Both are recorded; see [[people/calypso]] and [[knowledge/guest-gifts]].

## Open
- [ ] Say it to her, this morning, in words, before the tide.

Filed under [[ogygia/_index]].`,
    links: ["oaths/calypso-no-harm.md", "ogygia/island/day-1095-landfall.md", "ogygia/routine/meals.md", "ogygia/routine/clothing.md", "ogygia/workshop/tool-return.md", "ogygia/build/timber-log.md", "ogygia/workshop/sail-cloth.md", "ogygia/workshop/cordage.md", "ogygia/stores/provisions-aboard.md", "ogygia/build/sailing-directions.md", "people/calypso.md", "ogygia/_index.md", "decisions/accept-calypso-release.md", "knowledge/guest-gifts.md"],
    fields: { count: 10, repaid: 0 },
  },
];
