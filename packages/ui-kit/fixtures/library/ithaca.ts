// Library domain: ithaca. See ../README.md and ./types.ts.
//
// Home as news reaches Odysseus on Ogygia: the household, the hall, the
// stores, the suitors as group ledgers, Telemachus's voyage, the island and a
// dated news log. Every record says whether it is reported (and when the
// report arrived) or remembered from twenty years ago.

import type { LibraryDocument } from "./types.js";

export const ithacaDocuments: LibraryDocument[] = [
  /* ---------------------------------------------------------- method */
  {
    path: "ithaca/reported-and-remembered.md",
    title: "Reported and remembered",
    type: "method",
    created: "2019-08-03",
    updated: "2026-07-07",
    status: "active",
    tags: ["method", "sources"],
    summary: "How every record under ithaca/ marks what it knows: reported, with the date the report arrived, or remembered from twenty years ago.",
    body: `Nothing under this folder has been seen. That needs saying once, plainly, because a ledger in a confident hand starts to look like an inspection.

## Two kinds of knowing

- **Reported.** Someone else saw it and the word reached me. The record carries the date the report *arrived*, not the date the thing happened, and the source if I know it. Most reports are second-hand by the time they land, and some are third.
- **Remembered.** I saw it myself, twenty years ago, before the ships left. A memory is a fact about the island as it was in the year I sailed. Trees grow, people die, doors are rehung. A remembered record is a starting assumption, not a current state.

## Rules I hold myself to

1. A reported figure is copied exactly as it arrived. If two reports disagree, both stay, side by side, until I can count for myself.
2. A remembered detail is never upgraded to reported because it would be convenient.
3. Nothing reported about a person is acted on before landing. It goes on [[ithaca/questions-on-landing]] instead.
4. The news log in [[ithaca/news/log]] is dated by arrival. If a report contradicts an older one, the older one is not deleted; it is marked superseded. The same reports in the order things happened are on [[ithaca/timeline]].

The hub for all of it is [[ithaca/_index]], and the estate project is [[ithaca/estate]]. The first report filed this way is in [[journal/day-2400]].`,
    links: ["ithaca/questions-on-landing.md", "ithaca/news/log.md", "ithaca/timeline.md", "ithaca/_index.md", "ithaca/estate.md", "journal/day-2400.md"],
    fields: { confidence: "method" },
  },
  {
    path: "ithaca/timeline.md",
    title: "Ithaca, four years in order",
    type: "timeline",
    created: "2025-11-02",
    updated: "2026-07-09",
    status: "active",
    tags: ["timeline", "reported"],
    places: ["place:ithaca", "place:pylos", "place:sparta"],
    summary: "The reported sequence at home since the suitors came, with each event's report date beside it.",
    body: `Assembled from the news log. The left column is when it happened as far as I can tell; the right is when I heard. The gap between them is the honest measure of how far away I am.

| Event (approximate) | What | Report arrived |
| --- | --- | --- |
| twenty years ago | I sail for Troy; Telemachus an infant | remembered |
| day 620 | Anticleia tells me at the house of the dead how things stood | day 620 |
| about day 2192 | The suitors begin to sit in the hall | day 2400 |
| days 2192 to 3287 | The shroud for Laertes, woven and unpicked | day 3400 |
| before day 3221 | Laertes stops coming down to the town | day 3221 |
| about day 3305 | The unpicking is discovered | day 3400 |
| before day 3640 | The shroud finished | day 3640 |
| day 3642 | Telemachus calls the assembly, sails that night | day 3644 |
| day 3643 | Telemachus at Pylos | day 3646 |
| day 3645 | Telemachus at Sparta | day 3649 |
| day 3646 | The suitors learn he has gone; a ship is sent to Asteris | day 3646 |
| day 3651 | The eagle over the courtyard | day 3651 |

Four years of the suitors is 1,460 days, which matches [[ithaca/stores/drawdown]]. The dates of the first two rows from the hall are inferred backwards from that figure; nobody wrote down the day the first of them arrived.

See [[ithaca/news/log]] for the entries themselves, [[voyage/day-620-acheron]] for the first row that was told rather than reported, [[omens/day-3651-eagle]] for the last, and [[ithaca/_index]] for the rest.`,
    links: ["ithaca/stores/drawdown.md", "ithaca/news/log.md", "ithaca/_index.md", "voyage/day-620-acheron.md", "omens/day-3651-eagle.md"],
    fields: { confidence: "reported", span: "1,460 days" },
  },

  /* -------------------------------------------------------- household */
  {
    path: "ithaca/household/roster.md",
    title: "The household, by count",
    type: "ledger",
    created: "2019-08-10",
    updated: "2026-07-08",
    status: "active",
    tags: ["household", "roster"],
    people: ["person:penelope", "person:telemachus", "person:laertes", "person:eumaeus", "person:argos"],
    places: ["place:ithaca"],
    summary: "Who keeps the house, by role and number, with what is remembered and what has been reported since.",
    body: `Counts first, names only where the household itself used them. I have not invented a name for anyone I cannot place.

| Role | Count | Basis |
| --- | --- | --- |
| Penelope, holding the house | 1 | reported, day 3640 |
| Telemachus | 1 | reported away, day 3649 |
| Eurycleia, nurse, keeper of the stores | 1 | reported, day 3644 |
| Eurynome, housekeeper | 1 | remembered |
| Women servants in the hall | 50 | reported, day 3400 |
| of whom sided with the suitors | 12 | reported, day 3400 |
| Medon, herald | 1 | reported, day 3648 |
| Phemius, singer | 1 | reported, day 3400 |
| Eumaeus, swineherd, at the yard | 1 | reported, day 3614 |
| Philoetius, cowherd, on the mainland | 1 | remembered |
| Laertes and his people at the farm | 1 + servants | reported, day 3221 |
| Argos | 1 | remembered only |

Notes on the table:

- The fifty is Eurycleia's count, carried to me. The twelve is her count too. Their names were not in the report and are not guessed here; see [[ithaca/household/the-twelve]].
- My mother is not on it. She died while I was at sea; see [[ithaca/household/anticleia]].
- [[people/penelope]], [[people/telemachus]], [[people/laertes]], [[people/eumaeus]] and [[people/argos]] have their own cards, and so do [[people/eurycleia]], [[people/medon]], [[people/phemius]] and [[people/philoetius]].

Hub: [[ithaca/_index]].`,
    links: ["ithaca/household/the-twelve.md", "ithaca/household/anticleia.md", "people/penelope.md", "people/telemachus.md", "people/laertes.md", "people/eumaeus.md", "people/argos.md", "ithaca/_index.md", "people/eurycleia.md", "people/medon.md", "people/phemius.md", "people/philoetius.md"],
    fields: { confidence: "mixed", count: 61 },
  },
  {
    path: "ithaca/household/eurycleia.md",
    title: "Eurycleia",
    type: "person-note",
    created: "2019-08-10",
    updated: "2026-07-04",
    status: "active",
    tags: ["household", "stores"],
    people: ["person:telemachus", "person:penelope"],
    places: ["place:ithaca"],
    summary: "My nurse, and his. Keeps the storeroom day and night. Provisioned the boy's ship and was sworn to say nothing for eleven or twelve days.",
    body: `Remembered: bought by my father, [[people/laertes]], in her youth for the worth of twenty oxen, and he never took her to his bed, out of respect for my mother. She nursed me and then nursed Telemachus. She knows the scar on my leg from the boar on Parnassus ([[knowledge/wounds]]), because she bathed it. That is worth remembering for later and saying to no one now.

## Reported, day 3644

- She keeps the storeroom and its counts, day and night. If [[ithaca/stores/drawdown]] is accurate, it is accurate because of her.
- Telemachus came to her the night of the assembly and had her draw **twelve jars of wine** and **twenty measures of barley** for the ship.
- He made her swear not to tell his mother until the eleventh or twelfth day, or until Penelope missed him. She swore. She also wept, and argued, which I would have expected.
- She is the source of the count of the fifty women and the twelve. See [[ithaca/household/women-servants]].

## What not to do

Nothing that puts her between me and anyone in the hall. She is old. Ask her for the keys and the counts, and nothing that makes her a witness.

Back to [[ithaca/household/roster]]. Her card: [[people/eurycleia]].`,
    links: ["ithaca/stores/drawdown.md", "ithaca/household/women-servants.md", "ithaca/household/roster.md", "ithaca/_index.md", "people/laertes.md", "knowledge/wounds.md", "people/eurycleia.md"],
    fields: { confidence: "reported", reported: "2026-07-04", role: "nurse and keeper of stores" },
  },
  {
    path: "ithaca/household/women-servants.md",
    title: "The fifty women",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["household", "roster", "reported"],
    places: ["place:ithaca"],
    summary: "Fifty women serve in the hall. Thirty-eight kept faith with the household; twelve went over to the suitors. Counts only.",
    body: `Reported day 3400, and repeated in the same figures on day 3644. Source in both cases: [[people/eurycleia]]'s count, carried second-hand.

| | Women |
| --- | --- |
| Serving in the hall | 50 |
| Kept faith with Penelope | 38 |
| Sided with the suitors | 12 |

The work of fifty women is the work of the house: grinding at the mills, carding and spinning, water from the spring, the tables, the bedding, the lamps. The report said the mills alone take twelve.

What the report did *not* say: which women, how long, or whether any of the twelve were forced rather than willing. A woman in a hall with a hundred and eight armed men and no master has fewer choices than a count suggests. That question goes to [[ithaca/questions-on-landing]] and is not settled here.

The twelve have their own page, [[ithaca/household/the-twelve]], so that nothing about them is filed casually beside the bread.

Roster: [[ithaca/household/roster]]. The day the first figures came: [[journal/day-3400]].`,
    links: ["ithaca/questions-on-landing.md", "ithaca/household/the-twelve.md", "ithaca/household/roster.md", "ithaca/_index.md", "people/eurycleia.md", "journal/day-3400.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 50 },
  },
  {
    path: "ithaca/household/the-twelve.md",
    title: "The twelve",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-04",
    status: "open",
    tags: ["household", "reported", "judgement"],
    places: ["place:ithaca"],
    summary: "Twelve of the fifty women reported as having gone over to the suitors. No names held, no judgement made from here.",
    body: `Reported, day 3400: of the fifty women in the hall, twelve have taken the suitors' side, mock Penelope, and do not obey Eurycleia. Repeated, day 3644, with no change in the figure.

> Counts are not names. No name is recorded on this page and none should be added from rumour.

## What is held

- The number: 12.
- The source: one person's count, carried twice, through at least one other mouth.
- The charge: disloyalty, and some of them sharing beds with suitors.

## What is not held

- Who. [[people/eurycleia]] knows; I do not.
- Why. A girl taken into a household as a child, in a house with no master for twenty years and a hundred and eight men at the tables for four, is not in the position of a sworn man.
- Whether Penelope agrees with the count.

## Standing

Open. Nothing is decided about anyone on a second-hand count from nearly four hundred sea-miles away. This page exists so that, when it comes to it, I decide with the figure, the source and the doubt in front of me, not with my temper.

See [[ithaca/household/women-servants]] and [[ithaca/questions-on-landing]], and [[journal/day-3636]] for the hall as I wrote it up.`,
    links: ["ithaca/household/women-servants.md", "ithaca/questions-on-landing.md", "ithaca/_index.md", "people/eurycleia.md", "journal/day-3636.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 12 },
  },
  {
    path: "ithaca/household/penelope-standing.md",
    title: "Penelope's position",
    type: "assessment",
    created: "2025-11-02",
    updated: "2026-07-08",
    status: "active",
    tags: ["household", "reported"],
    people: ["person:penelope", "person:antinous", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "What she is holding, against whom, and with what. Reported through day 3648.",
    body: `[[people/penelope]] has held the house for twenty years with no word from me. For the last four she has held it against a hall full of men who say, not unreasonably by their lights, that a widow should remarry and the estate should settle.

## Reported, as of day 3648

- She has not chosen. The shroud bought three years; it is finished now and buys nothing more. See [[ithaca/loom/shroud]].
- Her father, [[people/icarius]], and her brothers are reported to be urging her to marry. See [[journal/day-3640]].
- The suitors' answer to every delay is to keep eating. See [[ithaca/stores/drawdown]].
- [[people/antinous]] speaks for them, and has said in open assembly that the fault is hers, not theirs.
- She did not know Telemachus had sailed until [[people/medon]] told her, on day 3646; that reached me on day 3648. See [[ithaca/household/medon]].

## What she has to work with

The keys to the storeroom. The loyalty of most of the women. Eumaeus and the herds. A son who has just become a man and has left the island. Her own judgement, which has been better than mine on every count I can check.

## What I told her when I left

That is on [[ithaca/departure-instructions]] and [[oaths/promise-to-penelope]]. It is the part of this record that is my responsibility rather than hers.

Back to [[ithaca/_index]].`,
    links: ["people/penelope.md", "ithaca/loom/shroud.md", "ithaca/stores/drawdown.md", "people/antinous.md", "ithaca/household/medon.md", "ithaca/departure-instructions.md", "ithaca/_index.md", "people/icarius.md", "journal/day-3640.md", "people/medon.md", "oaths/promise-to-penelope.md"],
    fields: { confidence: "reported", reported: "2026-07-08" },
  },
  {
    path: "ithaca/household/medon.md",
    title: "Medon, the herald",
    type: "person-note",
    created: "2026-07-08",
    updated: "2026-07-08",
    status: "active",
    tags: ["household", "reported"],
    people: ["person:penelope", "person:telemachus", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Serves the suitors' tables because he must, and told Penelope of the ambush plot he overheard from outside the courtyard.",
    body: `Remembered: a herald of the house, careful, not a fighting man. His card is [[people/medon]].

## Reported, day 3648

- He is counted among those who serve the suitors in the hall, with the singer, [[people/phemius]], and the two carvers. See [[ithaca/suitors/retinue]].
- He was outside the courtyard wall when [[people/antinous]] and the others planned the ship for Asteris. He went straight to [[people/penelope]] and told her: that [[people/telemachus]] had sailed for Pylos, and that men were going out to kill him on his way home.
- It was the first she had heard of either.

## Standing

Two records point at him. In the roster of men who serve the suitors, he is one of the hundred and eight and their people. In what he did, he is the reason Penelope knows. Both are true. I do not want the first to decide what happens to him when the second is the one that counts.

Add to [[ithaca/questions-on-landing]]: whether he is still in the hall, and whether anyone saw him leave the wall.

Roster: [[ithaca/household/roster]]. The plan he overheard, as it first reached me: [[journal/day-3646]].`,
    links: ["ithaca/suitors/retinue.md", "people/antinous.md", "people/penelope.md", "people/telemachus.md", "ithaca/questions-on-landing.md", "ithaca/household/roster.md", "ithaca/_index.md", "people/medon.md", "people/phemius.md", "journal/day-3646.md"],
    fields: { confidence: "reported", reported: "2026-07-08", role: "herald" },
  },
  {
    path: "ithaca/household/phemius.md",
    title: "Phemius, the singer",
    type: "person-note",
    created: "2025-11-02",
    updated: "2026-07-08",
    status: "active",
    tags: ["household", "reported"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Sings in the hall for the suitors because he is made to. Reported singing the returns from Troy, which Penelope asked him to stop.",
    body: `Remembered: the house's singer before I left, young then, good. His card is [[people/phemius]].

## Reported, day 3400

He sings for the suitors at their meals. Not by choice: the report says they compel him.

## Reported, day 3644

On the evening before the assembly he sang the hard homecoming of the Achaeans from Troy. [[people/penelope]] came down from her room and asked him to sing something else, because she could not bear that one. [[people/telemachus]] told her the singer is not to blame for the song, and sent her back up. It is reported as the first time he has spoken to her like the master of the house.

## Why it is filed

A singer who has been made to perform the story of the men who did not come home, every night, to the men who are eating my herds, is not a collaborator. Put him with [[people/medon]] in my mind, not with the hundred and eight. See [[ithaca/household/medon]] and [[ithaca/suitors/retinue]].

Roster: [[ithaca/household/roster]].`,
    links: ["people/penelope.md", "people/telemachus.md", "ithaca/household/medon.md", "ithaca/suitors/retinue.md", "ithaca/household/roster.md", "ithaca/_index.md", "people/phemius.md", "people/medon.md"],
    fields: { confidence: "reported", reported: "2026-07-04", role: "singer" },
  },
  {
    path: "ithaca/household/mentor.md",
    title: "Mentor",
    type: "person-note",
    created: "2019-08-10",
    updated: "2026-07-04",
    status: "active",
    tags: ["household", "remembered"],
    people: ["person:telemachus"],
    places: ["place:ithaca"],
    summary: "Left in charge of the household when I sailed. Spoke against the town at the assembly. Reported in two places at once, which needs explaining.",
    body: `Remembered: an old friend; his card is [[people/mentor]]. When the ships left I put the household in his charge and told the household to obey him and keep everything as it was. That instruction is twenty years old.

## Reported, day 3644

At the assembly he stood up after Telemachus and spoke not against the suitors but against the rest of Ithaca: that a crowd of townsmen sat silent while a few young men ate a house, when they could have stopped them by numbers. One of the suitors, [[people/leiocritus]], answered that numbers would not help against men at a feast, and dismissed the assembly.

## Reported, day 3646

That Mentor sailed with Telemachus on the night of the assembly. **Also** that Mentor was seen in the town the next morning.

Both cannot be the plain truth. I have a guess about who wore his shape on that ship, and I do not file guesses about gods as facts. Under [[ithaca/questions-on-landing]]: ask Mentor himself where he was.

See [[ithaca/telemachus/assembly]], [[ithaca/telemachus/ship-and-crew]] and [[journal/day-3644]].`,
    links: ["ithaca/questions-on-landing.md", "ithaca/telemachus/assembly.md", "ithaca/telemachus/ship-and-crew.md", "ithaca/_index.md", "people/mentor.md", "people/leiocritus.md", "journal/day-3644.md"],
    fields: { confidence: "mixed", reported: "2026-07-06", remembered: "twenty years ago" },
  },
  {
    path: "ithaca/household/anticleia.md",
    title: "My mother",
    type: "person-note",
    created: "2018-03-24",
    updated: "2025-05-07",
    status: "closed",
    tags: ["household", "dead"],
    people: ["person:penelope", "person:telemachus", "person:laertes", "person:teiresias"],
    places: ["place:acheron", "place:ithaca"],
    summary: "Anticleia. Died at home of longing for me while I was at sea. I learned it from her shade at the house of the dead, day 620.",
    body: `Alive when I sailed. Dead when I reached the house of the dead on day 620, where she came to the blood after [[people/teiresias]] had spoken and before I let her drink, which is a thing I have to live with.

## What she told me, day 620

- She did not die of sickness. She died of missing me.
- [[people/penelope]] was waiting in the hall, and her days and nights were spent in tears.
- [[people/telemachus]] held the lands in peace and was asked to the feasts that a magistrate is asked to.
- [[people/laertes]] no longer came to town. He slept in winter among the servants in the ashes by the fire, and in summer on fallen leaves in the vineyard.

## How to read it now

Her report is eight years older than anything else in this folder. The boy no longer holds the lands in peace. The part about my father has been confirmed since; see [[ithaca/news/day-3221-laertes]]. The rest was true when she said it.

I tried three times to hold her. That is not a fact for a ledger and it is here anyway.

Linked from [[knowledge/teiresias-forecast]] in my reading, and from [[ithaca/household/roster]]. Her card is [[people/anticleia]]; the day itself is [[voyage/day-620-acheron]] and [[journal/day-621]].`,
    links: ["people/teiresias.md", "people/penelope.md", "people/telemachus.md", "people/laertes.md", "ithaca/news/day-3221-laertes.md", "knowledge/teiresias-forecast.md", "ithaca/household/roster.md", "ithaca/_index.md", "people/anticleia.md", "voyage/day-620-acheron.md", "journal/day-621.md"],
    fields: { confidence: "told", day: 620, source: "Anticleia, at the house of the dead" },
  },
  {
    path: "ithaca/household/argos.md",
    title: "Argos, no report",
    type: "person-note",
    created: "2019-08-10",
    updated: "2026-07-12",
    status: "open",
    tags: ["household", "remembered"],
    people: ["person:argos"],
    places: ["place:ithaca"],
    summary: "Raised from a puppy and never hunted with. Twenty years without a single report of him.",
    body: `Every other member of the household has reached me in some report. [[people/argos]] has not. Not once in twenty years.

## Remembered

- I raised him myself and left before he was grown. I never took him hunting.
- He was fast. The young men took him after wild goats and deer and hares while I was at Troy, I suppose, or I hope.
- He would be twenty now. A dog of twenty is a dog at the very end.

## What I will not assume

That he is dead, because nobody has said so. That he is alive, because nobody has said so either. That anyone is looking after him: in a house where the master is gone and the stores are being drawn down, an old dog is the first thing to stop being anyone's job.

## On landing

He is on [[ithaca/homecoming-checklist]], not because there is anything to do but because I want to know. If he is alive he will know me before anyone does, and that is a risk as well as a kindness. Note it.

Roster: [[ithaca/household/roster]]. Thought about on Ogygia: [[journal/day-2555]], [[journal/day-3620]].`,
    links: ["people/argos.md", "ithaca/homecoming-checklist.md", "ithaca/household/roster.md", "ithaca/_index.md", "journal/day-2555.md", "journal/day-3620.md"],
    fields: { confidence: "remembered", age: "20 years", reports: 0 },
  },

  /* ------------------------------------------------------------ hall */
  {
    path: "ithaca/hall/plan.md",
    title: "The hall, as built",
    type: "plan",
    created: "2019-09-02",
    updated: "2025-11-02",
    status: "active",
    tags: ["hall", "remembered"],
    places: ["place:ithaca"],
    summary: "The layout of the house from memory: courtyard, great hall, the side door and passage, the women's quarters, the storeroom above.",
    body: `Drawn from memory on Ogygia. Twenty years old. Doors may have been rehung, walls patched; the bones of a stone house do not move.

## From the gate inwards

1. **The courtyard**, walled, with the altar of Zeus of the Courts ([[people/zeus]]) in it, and the gate to the road. The olive-tree chamber opens off the house itself, not the court; see [[ithaca/island/the-bed]].
2. **The threshold** of ash wood, and the great doors into the hall.
3. **The hall**: the long room with the hearth, the pillars, the high seats along the walls, the tables. Smoke goes out through the roof. Weapons hang on the walls; see [[ithaca/hall/weapons]].
4. **The side door**, raised, at the end of the hall, onto a narrow passage to the outside. One man can hold it.
5. **The women's quarters**, behind the hall, with their own door that can be barred from either side.
6. **The stairs** up to [[people/penelope]]'s rooms, and to the **storeroom**: [[ithaca/stores/storeroom]].

## What I do not know

- Whether anything has been built on since. Four years of a hundred and eight guests may have meant new sleeping places.
- Whether the side door still bars. That is the first thing to check.
- Where the twelve sleep, and where the suitors' men sleep. Ask: [[ithaca/questions-on-landing]].

See [[ithaca/hall/daily-pattern]] for how the room is used now, as reported.`,
    links: ["ithaca/island/the-bed.md", "ithaca/hall/weapons.md", "ithaca/stores/storeroom.md", "ithaca/questions-on-landing.md", "ithaca/hall/daily-pattern.md", "ithaca/_index.md", "people/zeus.md", "people/penelope.md"],
    fields: { confidence: "remembered", drawn: "Ogygia" },
  },
  {
    path: "ithaca/hall/weapons.md",
    title: "Arms on the hall walls",
    type: "inventory",
    created: "2019-09-02",
    updated: "2026-07-08",
    status: "open",
    tags: ["hall", "remembered", "stores"],
    places: ["place:ithaca"],
    summary: "Spears, shields and helmets hung in the hall when I left. Unknown whether they are still there, who has handled them, and whether the smoke has spoilt them.",
    body: `Remembered: arms hang in the hall, on the walls and by the pillars, as they do in any lord's house. Spears in the stand by the great pillar. Shields and helmets on the walls. Twenty years of hearth smoke have been going up past them.

## Open questions

- Are they still hanging, or have the suitors taken them down and carried them? The reports say nothing either way. A man at a feast does not usually wear a sword; a hundred and eight men who have been there four years may have stopped observing that.
- How many? I never counted. That was not a failure at the time.
- Who keeps the key to the inner storeroom where the better bronze is? [[people/penelope]], I believe. See [[ithaca/stores/storeroom]].

## A note to self

If arms are to be moved out of the hall before anything happens, it needs a reason that would satisfy a man who asks. Smoke damage is a true one: a spear left by a hearth for twenty years is not what it was. A true reason is easier to give than a false one.

Back to [[ithaca/hall/plan]]. Questions to [[ithaca/questions-on-landing]].`,
    links: ["ithaca/stores/storeroom.md", "ithaca/hall/plan.md", "ithaca/questions-on-landing.md", "ithaca/_index.md", "people/penelope.md"],
    fields: { confidence: "remembered", counted: false },
  },
  {
    path: "ithaca/hall/daily-pattern.md",
    title: "A day in the hall, as reported",
    type: "observation",
    created: "2025-11-02",
    updated: "2026-07-06",
    status: "active",
    tags: ["hall", "suitors", "reported"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "How the suitors spend the day: games before the house in the morning, the feast from midday, the singer, and back to their lodgings at night.",
    body: `Pieced from reports arriving on days 3400, 3644 and 3646. Nobody sent me a schedule; this is the shape the reports have in common.

| Time | Reported activity |
| --- | --- |
| Morning | Games on the levelled ground in front of the house: discus, javelin. |
| Mid-morning | Animals brought in from the herds; [[people/eumaeus]] sends the best of the swine. |
| Midday onward | Sacrifice, then the feast. Wine mixed in the bowls. The women serve. |
| Evening | The singer, [[people/phemius]]. Dancing. |
| Night | Most go to their own lodgings in the town; some sleep in the house. |

## What the pattern means

It is a routine. It has held for 1,460 days, near enough, and that makes it predictable. A predictable day has fixed points: when the hall is full, when it is empty, when the weapons are hung up and when the arms of the men are tired.

## What the pattern costs

The animals go in every day, whether anyone is hungry or not. The arithmetic is on [[ithaca/stores/daily-rate]].

[[people/antinous]] is reported to set the tone of the hall. That is the people record's business. This one is the room's.

Plan of the room: [[ithaca/hall/plan]]. The count of who sits in it: [[journal/day-3636]].`,
    links: ["ithaca/stores/daily-rate.md", "people/antinous.md", "ithaca/hall/plan.md", "ithaca/_index.md", "people/eumaeus.md", "people/phemius.md", "journal/day-3636.md"],
    fields: { confidence: "reported", reported: "2026-07-06" },
  },

  /* ----------------------------------------------------------- loom */
  {
    path: "ithaca/loom/shroud.md",
    title: "The shroud for Laertes",
    type: "record",
    created: "2025-11-02",
    updated: "2026-07-04",
    status: "closed",
    tags: ["loom", "reported", "household"],
    people: ["person:penelope", "person:laertes", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Woven by day, unpicked by night, for three years. Discovered in the fourth. Now finished.",
    body: `Reported, day 3400 ([[journal/day-3400]]). Confirmed day 3644, when [[people/antinous]] gave the whole account himself at the assembly as the reason the suitors are blameless.

## What she did

[[people/penelope]] set up a great loom in the hall and told the suitors she would choose when she had finished a shroud for [[people/laertes]], against the day he dies, so that no woman of the island could say the old man lay without one after all he had owned. It was an argument nobody could refuse.

She wove by day. At night, by torchlight, she unpicked what she had woven.

## How long

| Phase | Duration |
| --- | --- |
| Woven and unpicked | three years, about 1,095 days |
| Discovered | in the fourth year |
| Finished | after discovery, under compulsion; reported day 3640, [[journal/day-3640]] |

## How it ended

One of her women told. The suitors came in at night and found her at it. She had to finish it.

## What I take from it

Three years. Every night. With the suitors in the house and their women in her rooms. I have kept count of my own nights on this island ([[ogygia/routine/day-count]]) and I know what a thousand of them weigh. See [[ithaca/loom/discovery]] for the question of who told, [[people/penelope]], and [[journal/day-3618]].`,
    links: ["people/antinous.md", "people/penelope.md", "people/laertes.md", "ithaca/loom/discovery.md", "ithaca/_index.md", "journal/day-3400.md", "journal/day-3640.md", "ogygia/routine/day-count.md", "journal/day-3618.md"],
    fields: { confidence: "reported", reported: "2025-11-02", duration: "3 years" },
  },
  {
    path: "ithaca/loom/discovery.md",
    title: "Who told about the loom",
    type: "question",
    created: "2025-11-02",
    updated: "2026-07-04",
    status: "open",
    tags: ["loom", "household", "judgement"],
    people: ["person:penelope"],
    places: ["place:ithaca"],
    summary: "One of the women who knew told the suitors. The report does not say which, or whether she was one of the twelve.",
    body: `The report of day 3400 ([[journal/day-3400]]) says only: *one of the women, who knew, told.*

That raises three questions and settles none of them.

- [ ] Was the woman one of the twelve? The obvious answer is yes. The obvious answer is not evidence. See [[ithaca/household/the-twelve]].
- [ ] Was she pressed? Three years of a secret in a house where men with power over her life are asking every day is a long time.
- [ ] Did [[people/penelope]] know who, and has she done anything about it? If she has not, she had a reason.

## What is fixed

The shroud bought three years. It ended in the fourth. Nothing I do now changes how long it held. See [[ithaca/loom/shroud]].

## Standing

Open. Filed so it is not forgotten, and not forgotten so it is not acted on in a hurry. On the list at [[ithaca/questions-on-landing]], to ask Penelope, and only her.`,
    links: ["ithaca/household/the-twelve.md", "ithaca/loom/shroud.md", "ithaca/questions-on-landing.md", "ithaca/_index.md", "journal/day-3400.md", "people/penelope.md"],
    fields: { confidence: "reported", reported: "2025-11-02" },
  },

  /* ----------------------------------------------------------- stores */
  {
    path: "ithaca/stores/drawdown.md",
    title: "Stores drawdown",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["stores", "ledger", "reported"],
    people: ["person:penelope", "person:eumaeus"],
    places: ["place:ithaca"],
    summary: "Four years, 108 guests, five lines. 3,138 head and jars of 5,920 consumed. Nobody has been invoiced.",
    body: `As reported, line by line. These are the figures the household keeps and the figures I keep here; if they ever differ, the household's are right.

| Line | Consumed | Held | Share gone |
| --- | ---: | ---: | ---: |
| Swine | 1,180 | 1,800 | 66% |
| Sheep | 640 | 1,200 | 53% |
| Goats | 410 | 1,200 | 34% |
| Cattle | 96 | 720 | 13% |
| Wine, jars | 812 | 1,000 | 81% |
| **All lines** | **3,138** | **5,920** | **53%** |

- **Guests:** 108, before their retinue.
- **Period:** 1,460 days.
- **Invoiced:** nobody. Not one head of it.

## How to read the table

"Held" is the stock the household reported at the start of the period, as far as I can tell. The herds breed; the report does not say how far breeding has made up the loss, and I have not guessed. The wine does not breed.

## Per line

[[ithaca/stores/swine]], [[ithaca/stores/sheep]], [[ithaca/stores/goats]], [[ithaca/stores/cattle]], [[ithaca/stores/wine]]. The rate per day and how long each line lasts is on [[ithaca/stores/daily-rate]].

Project: [[ithaca/estate]]. The swine figures are [[people/eumaeus]]'s; the whole table read through again on [[journal/day-3616]].`,
    links: ["ithaca/stores/swine.md", "ithaca/stores/sheep.md", "ithaca/stores/goats.md", "ithaca/stores/cattle.md", "ithaca/stores/wine.md", "ithaca/stores/daily-rate.md", "ithaca/estate.md", "ithaca/_index.md", "people/eumaeus.md", "journal/day-3616.md"],
    fields: { confidence: "reported", guests: 108, days: 1460, invoiced: 0 },
  },
  {
    path: "ithaca/stores/daily-rate.md",
    title: "The rate, per day",
    type: "analysis",
    created: "2026-06-04",
    updated: "2026-07-12",
    status: "active",
    tags: ["stores", "ledger", "analysis"],
    places: ["place:ithaca"],
    summary: "The drawdown divided by 1,460 days, and how many days each line has left at that rate if nothing is replaced. The wine goes first.",
    body: `Plain division of the reported figures on [[ithaca/stores/drawdown]]. No breeding, no restocking, no change in appetite. It is a floor under the problem, not a forecast.

| Line | Consumed | Per day | Remaining | Days left at that rate |
| --- | ---: | ---: | ---: | ---: |
| Wine, jars | 812 | 0.56 | 188 | about 338 |
| Swine | 1,180 | 0.81 | 620 | about 767 |
| Sheep | 640 | 0.44 | 560 | about 1,277 |
| Goats | 410 | 0.28 | 790 | about 2,813 |
| Cattle | 96 | 0.07 | 624 | about 9,490 |

## What the numbers say

- The wine runs out in under a year. When it does, the hall changes.
- The swine run out in about two years. [[people/eumaeus]] will see that before anyone else; see [[ithaca/stores/swine]].
- Cattle are being taken slowly because they come over from the mainland. The rate there is about transport, not appetite; see [[ithaca/stores/cattle]].

## What they do not say

That the estate survives if the wine is replaced. A house is not only its stores. The women, the boy, the reputation of the place among the islands: none of those are on this table, and all of them are being drawn down too.

Twelve jars of wine went on [[people/telemachus]]'s ship, day 3642. Whether they are in the 812 is on [[ithaca/questions-on-landing]].`,
    links: ["ithaca/stores/drawdown.md", "ithaca/stores/swine.md", "ithaca/stores/cattle.md", "ithaca/questions-on-landing.md", "ithaca/_index.md", "people/eumaeus.md", "people/telemachus.md"],
    fields: { confidence: "derived", basis: "reported figures", days: 1460 },
  },
  {
    path: "ithaca/stores/swine.md",
    title: "Swine",
    type: "ledger-line",
    created: "2025-11-02",
    updated: "2026-06-04",
    status: "active",
    tags: ["stores", "herds", "reported"],
    people: ["person:eumaeus"],
    places: ["place:ithaca"],
    summary: "1,180 consumed of 1,800 held. The heaviest line by head, and the one Eumaeus sends in himself, the best animal each day.",
    body: `| Consumed | Held | Remaining | Share gone |
| ---: | ---: | ---: | ---: |
| 1,180 | 1,800 | 620 | 66% |

Reported, day 3614, through [[people/eumaeus]], whose count it is.

## How the line is drawn

Each day the suitors send to the yard for a fattened animal and Eumaeus has to choose the best one and drive it in. He does it because the alternative is that they come and take it, and take more. The report says he has kept the herds intact *as herds* against that rate, which is not the same as keeping them whole.

## Where they are kept

Mostly at the yard by Raven's Rock: [[ithaca/island/eumaeus-yard]]. Remembered there were other droves on the mainland, kept by other men. The report does not separate them and I have not tried.

## Rate

About 0.81 a day, 620 left, about 767 days at that rate with nothing bred. See [[ithaca/stores/daily-rate]].

Back to [[ithaca/stores/drawdown]]. Read line by line on [[journal/day-3616]].`,
    links: ["people/eumaeus.md", "ithaca/island/eumaeus-yard.md", "ithaca/stores/daily-rate.md", "ithaca/stores/drawdown.md", "ithaca/_index.md", "journal/day-3616.md"],
    fields: { confidence: "reported", reported: "2026-06-04", consumed: 1180, held: 1800 },
  },
  {
    path: "ithaca/stores/sheep.md",
    title: "Sheep",
    type: "ledger-line",
    created: "2025-11-02",
    updated: "2026-06-04",
    status: "active",
    tags: ["stores", "herds", "reported"],
    places: ["place:ithaca"],
    summary: "640 consumed of 1,200 held. More than half the flocks gone in four years.",
    body: `| Consumed | Held | Remaining | Share gone |
| ---: | ---: | ---: | ---: |
| 640 | 1,200 | 560 | 53% |

Reported, day 3400, and again unchanged in the figures of day 3614.

## Remembered

When I left, the flocks were kept partly on the island and partly across the water on the mainland pastures, by shepherds who were the household's men or hired. I cannot name them now and will not guess. Sheep are the line most affected by who is minding them, because a flock that is being taken from daily is also a flock that is not being culled or sold with any judgement.

## Rate

About 0.44 a day. 560 left, roughly 1,277 days at that rate if nothing were bred. The flocks do breed, so the real figure is better than that. How much better is a question for the shepherds, not for me at this distance.

## On landing

Find out who has the sheep, and whether they are still the household's men. See [[ithaca/questions-on-landing]].

Back to [[ithaca/stores/drawdown]]. Read line by line on [[journal/day-3616]].`,
    links: ["ithaca/questions-on-landing.md", "ithaca/stores/drawdown.md", "ithaca/_index.md", "journal/day-3616.md"],
    fields: { confidence: "reported", reported: "2025-11-02", consumed: 640, held: 1200 },
  },
  {
    path: "ithaca/stores/goats.md",
    title: "Goats",
    type: "ledger-line",
    created: "2025-11-02",
    updated: "2026-06-04",
    status: "active",
    tags: ["stores", "herds", "reported"],
    places: ["place:ithaca"],
    summary: "410 consumed of 1,200 held. Driven in daily by a goatherd whose loyalty the report questions.",
    body: `| Consumed | Held | Remaining | Share gone |
| ---: | ---: | ---: | ---: |
| 410 | 1,200 | 790 | 34% |

Reported, day 3400.

## The herds

Remembered: the goats graze the far end of the island, eleven herds of them, watched by the goatherds. Goats do well on Ithaca, which is not horse country and never will be; that is the island's one advantage in a ledger like this.

## The goatherd

Reported, day 3614, through [[people/eumaeus]]: the man who drives the goats in for the suitors' table has gone over to them. He eats with them and talks against the house. The report names him and I have not filed the name, because it came from one man about another and the two are known not to get on. It stays as: *one goatherd, reported disloyal, by one source*.

## Rate

About 0.28 a day. 790 left. At that rate the goats outlast everything else on [[ithaca/stores/daily-rate]] but the cattle.

Back to [[ithaca/stores/drawdown]]. Read line by line on [[journal/day-3616]].`,
    links: ["ithaca/stores/daily-rate.md", "ithaca/stores/drawdown.md", "ithaca/_index.md", "people/eumaeus.md", "journal/day-3616.md"],
    fields: { confidence: "reported", reported: "2025-11-02", consumed: 410, held: 1200 },
  },
  {
    path: "ithaca/stores/cattle.md",
    title: "Cattle",
    type: "ledger-line",
    created: "2025-11-02",
    updated: "2026-06-04",
    status: "active",
    tags: ["stores", "herds", "reported"],
    places: ["place:ithaca"],
    summary: "96 consumed of 720 held. The lightest line, because the cattle are on the mainland and have to be ferried over.",
    body: `| Consumed | Held | Remaining | Share gone |
| ---: | ---: | ---: | ---: |
| 96 | 720 | 624 | 13% |

Reported, day 3400.

## Why it is light

Ithaca has no meadows to speak of. The cattle are on the mainland across the strait, in the country of the Cephallenians, in the keeping of [[people/philoetius]]. Bringing one over takes a boat and a crossing. The suitors take cattle when they want a great sacrifice, not every day. See [[ithaca/island/philoetius-cattle]].

## A thing I cannot write without noting

I have been the man in a ledger of cattle before. Three hundred and fifty head of the Sun's herds on Thrinacia ([[knowledge/thrinacia-cattle]]), and the thirty-one men left by then who swore not to touch them ([[crew/oath-signatories]]). The comparison is not exact. These are mine to lose and those were not mine at all. But I know now what a hungry company will do to a herd it has been told is forbidden, and these have never been forbidden to anyone. See [[oaths/helios]] and [[decisions/cattle-of-helios]].

## Rate

About 0.07 a day. At that rate the cattle are the last line standing by a long way.

Back to [[ithaca/stores/drawdown]].`,
    links: ["ithaca/island/philoetius-cattle.md", "oaths/helios.md", "ithaca/stores/drawdown.md", "ithaca/_index.md", "people/philoetius.md", "knowledge/thrinacia-cattle.md", "decisions/cattle-of-helios.md", "crew/oath-signatories.md"],
    fields: { confidence: "reported", reported: "2025-11-02", consumed: 96, held: 720 },
  },
  {
    path: "ithaca/stores/wine.md",
    title: "Wine",
    type: "ledger-line",
    created: "2025-11-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["stores", "reported"],
    people: ["person:telemachus"],
    places: ["place:ithaca"],
    summary: "812 jars consumed of 1,000 held. The worst line in the ledger, and the only one that does not replace itself.",
    body: `| Consumed | Held | Remaining | Share gone |
| ---: | ---: | ---: | ---: |
| 812 | 1,000 | 188 | 81% |

Reported, day 3400; unchanged in the figure carried on day 3644.

## Where it is

In the storeroom, in jars along the wall, the old sweet wine kept for the day I came back. Remembered: I left it with that instruction, more or less as a joke. It has not been kept for that day. See [[ithaca/stores/storeroom]].

## The twelve jars

On the night of day 3642 [[people/eurycleia]] drew **twelve jars** for [[people/telemachus]]'s ship. I do not know if they are counted in the 812. If they are not, the remaining figure is 176.

## Rate

About 0.56 a day; 188 left; about 338 days. The wine goes before anything else on [[ithaca/stores/daily-rate]]. Vines are on the farm and on other men's land; a vintage is a year away and is not a thousand jars.

## Note

The worst line is the one that most changes the hall. Men drink less when there is less, and they also get worse about it.

Back to [[ithaca/stores/drawdown]].`,
    links: ["ithaca/stores/storeroom.md", "people/telemachus.md", "ithaca/stores/daily-rate.md", "ithaca/stores/drawdown.md", "ithaca/_index.md", "people/eurycleia.md"],
    fields: { confidence: "reported", reported: "2025-11-02", consumed: 812, held: 1000, unit: "jars" },
  },
  {
    path: "ithaca/stores/storeroom.md",
    title: "The storeroom",
    type: "inventory",
    created: "2019-09-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["stores", "remembered"],
    people: ["person:penelope"],
    places: ["place:ithaca"],
    summary: "Upstairs, behind a locked door with a bronze key. Gold, bronze, wrought iron, clothing, oil, the old wine, the bow of Eurytus and the twelve axes.",
    body: `Remembered, from twenty years ago, with one report since.

## Where

At the top of the house, up the stairs from the hall. A high door, closed by a bar drawn from outside with a strap, and a lock with a bent bronze key. [[people/penelope]] keeps the key; [[people/eurycleia]] keeps the room.

## What was in it when I left

- Gold and bronze in heaps.
- Wrought iron.
- Clothing in chests.
- Olive oil, sweet-smelling, in jars.
- The old wine, standing along the wall: [[ithaca/stores/wine]].
- The bow I had from Iphitus: [[ithaca/stores/bow-of-eurytus]].
- Its quiver, with arrows.
- The twelve axe-heads: [[ithaca/stores/twelve-axes]].

## Reported since

Day 3644 ([[journal/day-3644]]): Eurycleia still keeps the room day and night. The room has not been opened to the suitors. The wine and the barley for Telemachus's ship came out of it.

## Why it matters

Everything in this room has been kept back from the hall for four years. That is Penelope's doing and Eurycleia's. Whatever else has been lost, this has not. I have no other report that says so plainly about anything else.

Back to [[ithaca/stores/drawdown]].`,
    links: ["people/penelope.md", "ithaca/stores/wine.md", "ithaca/stores/bow-of-eurytus.md", "ithaca/stores/twelve-axes.md", "ithaca/stores/drawdown.md", "ithaca/_index.md", "people/eurycleia.md", "journal/day-3644.md"],
    fields: { confidence: "mixed", key: "bronze, held by Penelope" },
  },
  {
    path: "ithaca/stores/bow-of-eurytus.md",
    title: "The bow of Eurytus",
    type: "item",
    created: "2019-09-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["stores", "remembered", "weapons"],
    places: ["place:ithaca"],
    summary: "The great bow Iphitus gave me in Messene, his father Eurytus's. Never taken to Troy. Kept in the storeroom.",
    body: `Remembered in full; never reported on since, which in this case is good news.

## Where it came from

I was a young man in Messene on the household's business, about sheep stolen from Ithaca. I met Iphitus son of Eurytus there, in the house of Ortilochus. He was looking for horses. He gave me his father's bow; I gave him a sword and a spear. See [[knowledge/guest-gifts]]. We meant it as the start of a friendship between our houses ([[knowledge/guest-friendship]]). We never sat at each other's tables. He was killed before we could.

## The bow itself

- Long, recurved, very heavy to string. Few men can bend it. I could.
- I never took it to Troy. I used it at home and left it here, in memory of him.
- It lies in the storeroom with its quiver: [[ithaca/stores/storeroom]].

## Standing

It is not a weapon I can use from here and it is not one anyone in the hall can use at all, as far as I know. That fact may matter more than any other entry in this folder. Filed without saying how.

With [[ithaca/stores/twelve-axes]].`,
    links: ["ithaca/stores/storeroom.md", "ithaca/stores/twelve-axes.md", "ithaca/_index.md", "knowledge/guest-gifts.md", "knowledge/guest-friendship.md"],
    fields: { confidence: "remembered", given_by: "Iphitus", place: "Messene" },
  },
  {
    path: "ithaca/stores/twelve-axes.md",
    title: "The twelve axes",
    type: "item",
    created: "2019-09-02",
    updated: "2025-11-02",
    status: "active",
    tags: ["stores", "remembered"],
    places: ["place:ithaca"],
    summary: "Twelve axe-heads, set up in a line in the hall like the ribs of a keel, for a shot through all their holes. My own exercise, before Troy.",
    body: `Remembered.

## What they are

Twelve iron axe-heads with holes for the haft. Set upright in a straight trench in the hall floor, in a line, they stand like the props a shipwright sets under a keel. A man who can shoot an arrow cleanly through all twelve holes from the far end has a bow he can master and an eye that holds.

## Who used them

I did. Before the war. Not often, because it is not easy, and that is the point of it.

## Where they are

In the storeroom with the bow, at last report of anything: [[ithaca/stores/storeroom]]. Nobody has reported them moved.

## What I know about them that no one else does

- How deep the trench has to be cut, and in which direction along the hall, so the line is true.
- How far back to stand.

Neither of those is written down here in figures. [[people/penelope]] knows the axes and what they were for. That is enough for now.

With [[ithaca/stores/bow-of-eurytus]]. Plan of the hall: [[ithaca/hall/plan]].`,
    links: ["ithaca/stores/storeroom.md", "ithaca/stores/bow-of-eurytus.md", "ithaca/hall/plan.md", "ithaca/_index.md", "people/penelope.md"],
    fields: { confidence: "remembered", count: 12 },
  },

  /* ---------------------------------------------------------- suitors */
  {
    path: "ithaca/suitors/roster.md",
    title: "The suitors, by island",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-08",
    status: "active",
    tags: ["suitors", "roster", "reported"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "108 men from four islands: 52 Dulichium, 24 Same, 20 Zacynthus, 12 Ithaca. Plus their retinue.",
    body: `Reported, day 3400, and repeated with the same totals on day 3644. These are group counts. Individuals have people records; this is a ledger of where they come from, because that is the shape of what follows.

| Home island | Men | Notes |
| --- | ---: | --- |
| Dulichium | 52 | the largest party, with six serving-men of their own |
| Same | 24 | the nearest neighbour across the strait |
| Zacynthus | 20 | the wooded island to the south |
| Ithaca | 12 | our own; sons of the island's leading houses |
| **Total** | **108** | |

Retinue counted separately: [[ithaca/suitors/retinue]].

## Why by island

Every one of these men has a father, brothers and a town that will hear what happens to him. Fifty-two families on Dulichium is not the same problem as twelve on Ithaca. The twelve from home are neighbours whose fathers I fought beside or grew up with.

## Per island

[[ithaca/suitors/dulichium]], [[ithaca/suitors/same]], [[ithaca/suitors/zacynthus]], [[ithaca/suitors/ithacans]]. What they say they want: [[ithaca/suitors/their-case]]. Their families: [[ithaca/suitors/families]].

[[people/antinous]] is counted among the twelve from Ithaca. Other people records: [[people/eurymachus]], [[people/amphinomus]], [[people/ctesippus]], [[people/leodes]].`,
    links: ["ithaca/suitors/retinue.md", "ithaca/suitors/dulichium.md", "ithaca/suitors/same.md", "ithaca/suitors/zacynthus.md", "ithaca/suitors/ithacans.md", "ithaca/suitors/their-case.md", "ithaca/suitors/families.md", "people/antinous.md", "ithaca/_index.md", "people/eurymachus.md", "people/amphinomus.md", "people/ctesippus.md", "people/leodes.md"],
    fields: { confidence: "reported", reported: "2025-11-02", total: 108 },
  },
  {
    path: "ithaca/suitors/dulichium.md",
    title: "From Dulichium: 52",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "reported"],
    summary: "Fifty-two young men from Dulichium, the largest party in the hall, with six serving-men.",
    body: `Reported, day 3400.

| | Count |
| --- | ---: |
| Suitors from Dulichium | 52 |
| Their own serving-men | 6 |

## Remembered of Dulichium

A rich island, grain and grass, the largest of the group by land under the plough. Its men fought at Troy under their own captain, not under me. I knew them as allies, not as mine.

## Reported character of the party

Not uniform. One of their leaders is reported as the most decent man in the hall: speaks against violence, argued against killing Telemachus, has a good name at home. That is a people record's business, and the name is not filed here. It matters to this ledger only as a reminder that fifty-two is not one opinion.

## What it means

Fifty-two families on one island, all of whom will hear the same news on the same day. If the house of Ithaca has a quarrel with Dulichium after this, it will be a quarrel between islands, not between men.

Back to [[ithaca/suitors/roster]]. The families: [[ithaca/suitors/families]]. The hall as I wrote it up: [[journal/day-3636]].`,
    links: ["ithaca/suitors/roster.md", "ithaca/suitors/families.md", "ithaca/_index.md", "journal/day-3636.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 52, island: "Dulichium" },
  },
  {
    path: "ithaca/suitors/same.md",
    title: "From Same: 24",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "reported"],
    summary: "Twenty-four men from Same, the island across the narrow strait. Asteris, where the ambush ship waits, lies between us.",
    body: `Reported, day 3400. One of them, [[people/ctesippus]], has a people record.

| | Count |
| --- | ---: |
| Suitors from Same | 24 |

## Remembered of Same

The big island to the west across the strait, high and close. You can see its hills from the town. Families there marry into families here and always have. When I left, Same's men sailed with me; some of them were in my twelve ships: [[crew/ships/ship-06]], [[crew/ships/ship-07]], [[crew/ships/ship-08]].

That last line is the hard one. Some of these twenty-four may be the sons of men I took to Troy and did not bring back. See [[crew/_index]].

## Asteris

The rocky island in the strait between Ithaca and Same, with a harbour that opens both ways, is where the suitors have sent their ship to wait for Telemachus: [[ithaca/suitors/ambush-ship]]. I note that a ship waiting there is a ship within sight of both islands' shores.

Back to [[ithaca/suitors/roster]].`,
    links: ["crew/_index.md", "ithaca/suitors/ambush-ship.md", "ithaca/suitors/roster.md", "ithaca/_index.md", "crew/ships/ship-06.md", "crew/ships/ship-07.md", "crew/ships/ship-08.md", "people/ctesippus.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 24, island: "Same" },
  },
  {
    path: "ithaca/suitors/zacynthus.md",
    title: "From Zacynthus: 20",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["suitors", "reported"],
    summary: "Twenty men from wooded Zacynthus, the furthest of the four islands from the hall.",
    body: `Reported, day 3400.

| | Count |
| --- | ---: |
| Suitors from Zacynthus | 20 |

## Remembered of Zacynthus

The wooded island, south, the furthest of the four. Timber, and a good harbour. Its men were in the contingent I led to Troy, with Same's and ours and those from the mainland shore; they filled [[crew/ships/ship-09]] and [[crew/ships/ship-10]].

## Reported

Nothing that separates them from the hall in general. No individual report. They are the party I know least about.

## Distance

Of the four groups, these are the men with the longest voyage home and the least daily contact with the town. Four years at a table a day's sail from your own house is a long time for a suit. It suggests either great patience or that staying is easier than leaving. The report does not say which, and I note that I do not know.

## What I will need

- Who leads them.
- Whether they lodge in the house or in the town.

Both on [[ithaca/questions-on-landing]]. Back to [[ithaca/suitors/roster]].`,
    links: ["ithaca/questions-on-landing.md", "ithaca/suitors/roster.md", "ithaca/_index.md", "crew/ships/ship-09.md", "crew/ships/ship-10.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 20, island: "Zacynthus" },
  },
  {
    path: "ithaca/suitors/ithacans.md",
    title: "From Ithaca: 12",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "reported", "families"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "Twelve men of our own island, from its best houses. Antinous is one of them. They grew up within sight of the hall.",
    body: `Reported, day 3400.

| | Count |
| --- | ---: |
| Suitors from Ithaca | 12 |

## Who they are, as a group

The sons of the island's leading families. Men who were boys when I left, or not yet born to fathers I knew. Their fathers sat in my assembly. Some of their fathers sailed with me and did not come back ([[crew/families-owed-news]]); their sons have grown up without them, as mine has.

[[people/antinous]] is one of the twelve and speaks for the whole hall. Another of the twelve is reported as the sharpest talker after him and as having threatened [[people/halitherses]] at the assembly. Names stay in the people records.

## Why this group is different

The men from Dulichium and Same and Zacynthus can go home. These twelve are home. Whatever happens in the hall, they and their families are still my neighbours in the morning, and their fathers will sit in the next assembly with the same right to speak as anyone.

That is the line from this ledger to [[ithaca/suitors/families]], and it is the hardest one in the folder.

Back to [[ithaca/suitors/roster]].`,
    links: ["people/antinous.md", "ithaca/suitors/families.md", "ithaca/suitors/roster.md", "ithaca/_index.md", "people/halitherses.md", "crew/families-owed-news.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 12, island: "Ithaca" },
  },
  {
    path: "ithaca/suitors/retinue.md",
    title: "Who serves the suitors",
    type: "ledger",
    created: "2025-11-02",
    updated: "2026-07-08",
    status: "active",
    tags: ["suitors", "household", "reported"],
    places: ["place:ithaca"],
    summary: "Six serving-men from Dulichium, two carvers, the herald and the singer. Some brought, some compelled.",
    body: `Reported, day 3400, alongside the roster. The report lists these with the 108 because they are at the suitors' tables every day. That does not make them the same thing.

| Who | Count | Whose |
| --- | ---: | --- |
| Serving-men with the Dulichium party | 6 | brought by the suitors |
| Carvers, skilled at the meat | 2 | the household's, serving the suitors |
| [[people/medon]], herald | 1 | the household's |
| [[people/phemius]], singer | 1 | the household's |
| **Total** | **10** | |

## The distinction that matters

- Six of the ten came with the suitors and are their men.
- Four of the ten are the household's own, working the tables because the suitors are in the house. Two of them have their own records for what they have done since: [[ithaca/household/medon]] and [[ithaca/household/phemius]].

## Add to this

The women of the hall serve too, and are not counted here: [[ithaca/household/women-servants]]. And the goatherd who drives in the goats has gone over in his loyalties; that is on [[ithaca/stores/goats]].

Back to [[ithaca/suitors/roster]].`,
    links: ["ithaca/household/medon.md", "ithaca/household/phemius.md", "ithaca/household/women-servants.md", "ithaca/stores/goats.md", "ithaca/suitors/roster.md", "ithaca/_index.md", "people/medon.md", "people/phemius.md"],
    fields: { confidence: "reported", reported: "2025-11-02", count: 10 },
  },
  {
    path: "ithaca/suitors/their-case.md",
    title: "The suitors' case, stated fairly",
    type: "assessment",
    created: "2026-07-04",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "reported", "judgement"],
    people: ["person:antinous", "person:penelope", "person:telemachus"],
    summary: "What they say they want and why they say they are entitled to it, as reported from the assembly. Written as they would put it, not as I would.",
    body: `Reported from the assembly of day 3642, report arrived day 3644 ([[journal/day-3644]]). I am writing their side as straight as I can, because a man who cannot state his opponent's case does not understand his own position.

## As they put it

1. **He is dead.** Twenty years. Ten since Troy fell. Every other living man came home or is known to be dead. It is not a cruelty to say so; it is the plain reading.
2. **She should remarry.** A woman of her house, widowed, is expected to go back to her father's house, to [[people/icarius]], and be married from there, or to choose a husband here. Either settles the estate.
3. **She has deceived them.** Three years of the loom. [[people/antinous]] said in assembly that the fault is hers for leading them on, and that they will stay until she chooses.
4. **The boy can end it.** Send his mother to her father and let her marry, and they go home.

## What is true in it

Points 1 and 2 are what I would have said of another man's house. Point 3 is accurate as to the facts. Point 4 is what a reasonable outsider would advise.

## What is not

None of it is a reason to eat the house while waiting. A suitor brings gifts. These have brought appetite. [[ithaca/stores/drawdown]] is the answer to the claim that they are only waiting.

And none of it is a reason to send a ship to kill a boy of twenty: [[ithaca/suitors/ambush-ship]].

See [[ithaca/telemachus/assembly]].`,
    links: ["people/antinous.md", "ithaca/stores/drawdown.md", "ithaca/suitors/ambush-ship.md", "ithaca/telemachus/assembly.md", "ithaca/_index.md", "journal/day-3644.md", "people/icarius.md"],
    fields: { confidence: "reported", reported: "2026-07-04" },
  },
  {
    path: "ithaca/suitors/ambush-ship.md",
    title: "The ship at Asteris",
    type: "threat",
    created: "2026-07-06",
    updated: "2026-07-10",
    status: "active",
    tags: ["suitors", "telemachus", "danger"],
    people: ["person:antinous", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Twenty men in a fast ship, waiting at Asteris in the strait between Ithaca and Same, to take Telemachus on his way home.",
    body: `Reported, day 3646 ([[journal/day-3646]]). Confirmed day 3648 through [[people/medon]].

## What

When the suitors learned that [[people/telemachus]] had sailed, [[people/antinous]] asked for a fast ship and twenty men, to wait for him in the strait between Ithaca and rugged Same and kill him on the way back. They chose the men that evening and the ship went out.

## Where

Asteris: a small rocky island in the strait, with a harbour open at both ends. A ship there can come out either way, and it sits across the line any ship from Pylos would take to the town harbour.

| | |
| --- | --- |
| Ship | one, fast, lent by one of the suitors |
| Men | 20 |
| Station | Asteris |
| Target | Telemachus, returning from Pylos or Sparta |
| Since | day 3646 |

## What I can do from here

Nothing. That is the fact at the top of this record and I have written it here so that I do not keep looking for another answer.

## What he could do

Not come home by the strait. Not come home by day. Not land at the town harbour. Land elsewhere on the island and go to [[people/eumaeus]] first. Whether anyone is telling him so is on [[ithaca/telemachus/return-risk]].

Logged in [[ithaca/news/day-3646-ambush]].`,
    links: ["people/telemachus.md", "people/antinous.md", "ithaca/telemachus/return-risk.md", "ithaca/news/day-3646-ambush.md", "ithaca/_index.md", "journal/day-3646.md", "people/medon.md", "people/eumaeus.md"],
    fields: { confidence: "reported", reported: "2026-07-06", men: 20, station: "Asteris" },
  },
  {
    path: "ithaca/suitors/families.md",
    title: "The families behind the 108",
    type: "assessment",
    created: "2026-07-06",
    updated: "2026-07-12",
    status: "open",
    tags: ["suitors", "families", "judgement"],
    people: ["person:antinous", "person:laertes"],
    places: ["place:ithaca"],
    summary: "Every suitor is a son of a house. What follows in the hall follows in four islands. Written before deciding anything.",
    body: `Not reported; reasoned. Written so that whatever I decide is decided knowing this.

## The count, again

| Island | Men | Houses, at least |
| --- | ---: | --- |
| Dulichium | 52 | many |
| Same | 24 | many |
| Zacynthus | 20 | many |
| Ithaca | 12 | twelve of the best on the island |

## What a family does

A father whose son dies in another man's hall comes for a price or for blood. He is not wrong to. That is the law of every island I have ever stood on, and it was mine before I left. [[people/antinous]] has a father living, [[people/eupeithes]], as far as I know, who was once in debt to my own house for his life. That is remembered and not reported, and it may be the most important line on this page.

## What follows

- The quarrel does not end in the hall.
- [[people/laertes]] is old and on the farm, and is my nearest kin on the island after the boy.
- Some of these houses lost men in my ships. Their account with me is already open; see [[crew/_index]] and [[crew/families-owed-news]].

## Standing

Open. Nothing here is a plan. It is the cost column of something that does not have a benefit column yet.

Roster: [[ithaca/suitors/roster]].`,
    links: ["people/antinous.md", "people/laertes.md", "crew/_index.md", "ithaca/suitors/roster.md", "ithaca/_index.md", "people/eupeithes.md", "crew/families-owed-news.md"],
    fields: { confidence: "reasoned" },
  },

  /* -------------------------------------------------------- telemachus */
  {
    path: "ithaca/telemachus/remembered.md",
    title: "The boy, as I left him",
    type: "memory",
    created: "2019-08-10",
    updated: "2026-07-09",
    status: "closed",
    tags: ["telemachus", "remembered"],
    people: ["person:telemachus", "person:penelope"],
    places: ["place:ithaca"],
    summary: "An infant in his mother's arms when the ships left. Everything else I know about him has been reported.",
    body: `Remembered. The whole of it fits in a paragraph.

He was a baby when the ships left for Troy. I did not want to go, and when the men came to fetch me I pretended to be mad: yoked an ox and an ass and ploughed the shore and sowed it with salt. One of them, [[people/palamedes]], took the boy out of Penelope's arms and set him down in front of the plough. I turned the plough aside. That settled it, and I went.

So the one clear memory I have of my son is of turning a plough so it would not hit him. He will not remember it.

## Everything since is reported

- From my mother at the house of the dead, day 620: that he held the lands in peace. See [[ithaca/household/anticleia]] and [[journal/day-621]].
- From the assembly, day 3644: that he stood in my place and spoke, and asked for a ship. See [[ithaca/telemachus/assembly]].
- That he is now at Sparta: [[ithaca/telemachus/route]].

He is twenty; see [[journal/day-3632]]. I have never heard his voice as a man's. When I do, I will need to remember that I am a stranger to him, and he owes me nothing he has not decided to give.

People card: [[people/telemachus]].`,
    links: ["ithaca/household/anticleia.md", "ithaca/telemachus/assembly.md", "ithaca/telemachus/route.md", "people/telemachus.md", "ithaca/_index.md", "people/palamedes.md", "journal/day-621.md", "journal/day-3632.md"],
    fields: { confidence: "remembered", age_then: "infant", age_now: 20 },
  },
  {
    path: "ithaca/telemachus/assembly.md",
    title: "The assembly Telemachus called",
    type: "record",
    created: "2026-07-04",
    updated: "2026-07-06",
    status: "closed",
    tags: ["telemachus", "assembly", "reported"],
    people: ["person:telemachus", "person:antinous", "person:penelope"],
    places: ["place:ithaca"],
    summary: "The first assembly on Ithaca since I sailed. He asked the town to stop the suitors, was refused, and asked for a ship.",
    body: `Held day 3642. Report arrived day 3644.

## Order of business

1. **[[people/aegyptius]]** opened it: an old man, whose son sailed with me, asked who had called the first assembly since I left, and whether there was news of the army.
2. **[[people/telemachus]]** spoke. No news of the army. A private matter: his father dead or lost, and his house being eaten by men who will not go to his mother's father to ask for her properly. He threw the staff down and wept.
3. **[[people/antinous]]** answered: the fault is Penelope's. Told the loom story; see [[ithaca/loom/shroud]]. Send her to her father and let her choose.
4. **Telemachus** refused: he will not drive his mother from the house.
5. An omen; see below.
6. **[[people/halitherses]]** read it as my return. One of the suitors threatened him.
7. **Mentor** rebuked the town for sitting silent. See [[ithaca/household/mentor]].
8. **Telemachus** asked for a ship and twenty men to go to Pylos and Sparta for news.
9. Dismissed by one of the suitors, [[people/leiocritus]], without a vote.

## The omen

Two eagles, sent from the mountain, flew level on the wind, then wheeled over the assembly, struck at each other's heads and necks, and swept off east over the houses. Filed as observed at [[omens/day-3644-two-eagles]]; Halitherses's reading is his.

## What it shows

He spoke well, lost, and did not stop. See [[ithaca/telemachus/ship-and-crew]].`,
    links: ["people/telemachus.md", "people/antinous.md", "ithaca/loom/shroud.md", "ithaca/household/mentor.md", "ithaca/telemachus/ship-and-crew.md", "ithaca/_index.md", "people/aegyptius.md", "people/halitherses.md", "people/leiocritus.md", "omens/day-3644-two-eagles.md"],
    fields: { confidence: "reported", reported: "2026-07-04", day: 3642 },
  },
  {
    path: "ithaca/telemachus/ship-and-crew.md",
    title: "His ship and crew",
    type: "record",
    created: "2026-07-04",
    updated: "2026-07-08",
    status: "active",
    tags: ["telemachus", "ship", "reported"],
    people: ["person:telemachus"],
    places: ["place:ithaca", "place:pylos"],
    summary: "A borrowed ship and twenty volunteers. Sailed from the town harbour at night, day 3642, with twelve jars of wine and twenty measures of barley.",
    body: `Reported, day 3644, with a detail added day 3646.

| | |
| --- | --- |
| Ship | lent by [[people/noemon]], son of Phronius |
| Crew | 20, volunteers from the town |
| Stores | 12 jars of wine, 20 measures of barley meal, in leather sacks |
| Sailed | night of day 3642, from the town harbour |
| Wind | a fresh westerly, reported as fair for Pylos |
| Companion | reported as Mentor; see note |

## The crew

Twenty men who chose to go. Their names were not in the report. I have kept a ledger of six hundred men who went to sea on my account and none came back ([[crew/fleet-strength]]). I will keep this one too, and I would like it to close the other way.

## The ship's owner

Noemon lent it, and on day 3646 asked in the town, openly, when he could have it back because he needed it to fetch a mule from Elis. That is how the suitors learned the boy had gone. Noemon is not to blame. He asked a fair question about his own ship.

## The companion

Reported as [[people/mentor]], and Mentor was reported in town the next morning. See [[ithaca/household/mentor]].

Route: [[ithaca/telemachus/route]]. The danger on the way home: [[ithaca/suitors/ambush-ship]]. Crew ledger of the first voyage: [[crew/_index]].`,
    links: ["ithaca/household/mentor.md", "ithaca/telemachus/route.md", "ithaca/suitors/ambush-ship.md", "crew/_index.md", "ithaca/_index.md", "people/noemon.md", "crew/fleet-strength.md", "people/mentor.md"],
    fields: { confidence: "reported", reported: "2026-07-04", crew: 20 },
  },
  {
    path: "ithaca/telemachus/route.md",
    title: "His route: Pylos, then Sparta",
    type: "route",
    created: "2026-07-06",
    updated: "2026-07-09",
    status: "active",
    tags: ["telemachus", "route", "reported"],
    people: ["person:telemachus", "person:nestor", "person:menelaus"],
    places: ["place:ithaca", "place:pylos", "place:sparta"],
    summary: "Overnight by sea to Pylos, then two days by chariot overland to Sparta with Nestor's son. The ship waits at Pylos.",
    body: `Reported in two pieces: Pylos on day 3646, Sparta on day 3649. The passage as I worked it out before either arrived: [[journal/day-3645]].

| Leg | From | To | How | Arrived |
| --- | --- | --- | --- | --- |
| 1 | Ithaca, town harbour | Pylos | ship, overnight | day 3643, morning |
| 2 | Pylos | Pherae | chariot, overland, with Nestor's son | day 3644, night |
| 3 | Pherae | Sparta | chariot | day 3645, evening |

## At Pylos

Reached the beach while [[people/nestor]] and his people were sacrificing bulls to [[people/poseidon]]. I note the god, and leave it there. Nestor received him, told him what he knew of the return of the others, and sent him overland to [[people/menelaus]] with his own son, [[people/peisistratus]], and a chariot. The ship and crew stayed at Pylos.

## At Sparta

Arrived during a double wedding in Menelaus's house. Received. What he was told there is on [[ithaca/telemachus/what-he-heard]].

## The way home

The chariot back to Pylos, then the ship, then the open sea north to Ithaca, past the strait at Asteris. See [[ithaca/telemachus/return-risk]].

Who he was when I left: [[ithaca/telemachus/remembered]]. My own route home, for comparison: [[voyage/_index]].`,
    links: ["people/nestor.md", "people/menelaus.md", "ithaca/telemachus/what-he-heard.md", "ithaca/telemachus/return-risk.md", "ithaca/telemachus/remembered.md", "voyage/_index.md", "ithaca/_index.md", "journal/day-3645.md", "people/poseidon.md", "people/peisistratus.md"],
    fields: { confidence: "reported", reported: "2026-07-09", legs: 3 },
  },
  {
    path: "ithaca/telemachus/what-he-heard.md",
    title: "What he was told abroad",
    type: "record",
    created: "2026-07-09",
    updated: "2026-07-09",
    status: "active",
    tags: ["telemachus", "reported", "sources"],
    people: ["person:telemachus", "person:nestor", "person:menelaus", "person:calypso"],
    places: ["place:pylos", "place:sparta", "place:ogygia"],
    summary: "Nestor knew how the fleets left Troy but not where I went. Menelaus heard from the Old Man of the Sea that I am held on an island. He is right.",
    body: `Reported in two pieces: Nestor's on day 3646, Menelaus's on day 3649. Third-hand at least: what they told him, as it reached me.

## From Nestor at Pylos

- How the Achaeans quarrelled after Troy and left in two parties.
- That I turned back from Tenedos to rejoin [[people/agamemnon]], and he lost sight of me after that.
- Who came home, who died. Nothing of me after Tenedos.

[[people/nestor]] answered every question he was asked at length. It was all true and none of it was what the boy came for.

## From Menelaus at Sparta

- [[people/menelaus]] was becalmed off Egypt on his own way home and caught the Old Man of the Sea, [[people/proteus]], who has to answer if held.
- Among what he was told: that I am alive, on an island, held in the house of the nymph [[people/calypso]], with no ship and no crew to get away.

## Assessment

Accurate, as of day 3649. It is the first report out of Ithaca's circle that knows where I am. It is also nearly out of date: the raft goes in the water today. Nobody in Sparta knows that, and nobody will until I am somewhere else.

See [[ithaca/telemachus/route]], [[voyage/ogygia/raft]] and [[journal/day-3649]].`,
    links: ["people/nestor.md", "people/menelaus.md", "people/calypso.md", "ithaca/telemachus/route.md", "voyage/ogygia/raft.md", "ithaca/_index.md", "people/agamemnon.md", "people/proteus.md", "journal/day-3649.md"],
    fields: { confidence: "reported", reported: "2026-07-09", source: "Menelaus, via the Old Man of the Sea" },
  },
  {
    path: "ithaca/telemachus/return-risk.md",
    title: "His way home",
    type: "risk",
    created: "2026-07-06",
    updated: "2026-07-12",
    status: "open",
    tags: ["telemachus", "danger", "route"],
    people: ["person:telemachus", "person:athena", "person:eumaeus", "person:antinous"],
    places: ["place:pylos", "place:ithaca"],
    summary: "The ambush sits across his route home. What he should do differs from what he is likely to do. I cannot reach him.",
    body: `Opened day 3646 ([[journal/day-3646]]). Nothing has closed it.

## The threat

Twenty men in a ship at Asteris, in the strait, waiting for him: [[ithaca/suitors/ambush-ship]].

## What he should do

What I wished for him before any of this is on [[journal/day-3638]].

- [ ] Leave Pylos without lingering, once he is back from Sparta.
- [ ] Keep well away from the islands on the run north.
- [ ] Sail at night through the dangerous stretch.
- [ ] Land on the first shore of Ithaca, not at the town harbour.
- [ ] Send the ship and crew on round to the town without him.
- [ ] Go on foot to [[people/eumaeus]] at the yard, and stay the night there.
- [ ] Send word to his mother from there.

## What he is likely to do

Come home the way he went, by daylight, to the town. He is twenty and has never been at sea before this.

## What I can do

Nothing. I have no channel to him and none to Penelope. [[people/athena]] has taken an interest in the boy, if the reports are read one way; see [[knowledge/athena-favour]]. I do not file that as a plan.

## Who has the advantage

[[people/antinous]] knows the strait. The boy knows nothing of the ship waiting there unless someone tells him.

Open until a report says he is home. Logged in [[ithaca/news/log]].`,
    links: ["ithaca/suitors/ambush-ship.md", "people/eumaeus.md", "people/athena.md", "people/antinous.md", "ithaca/news/log.md", "ithaca/_index.md", "journal/day-3646.md", "journal/day-3638.md", "knowledge/athena-favour.md"],
    fields: { confidence: "reasoned", opened: "2026-07-06" },
  },

  /* ------------------------------------------------------------ island */
  {
    path: "ithaca/island/geography.md",
    title: "The island, from memory",
    type: "place-note",
    created: "2019-08-20",
    updated: "2025-11-02",
    status: "active",
    tags: ["island", "remembered"],
    places: ["place:ithaca"],
    summary: "Rough, narrow, no room for horses, good for goats. Neriton above the town, the harbour of Phorcys, Raven's Rock and Arethusa, the farm in the uplands.",
    body: `Remembered. Drawn on Ogygia from twenty years ago, and corrected against nothing, because nothing has come to correct it.

> A rugged island, not broad, not for driving horses, but not poor either. Grain and wine, rain and dew, good for goats and cattle, timber of every kind, and water all the year round.

That is how I would describe it to a stranger and how I have described it, here, to myself.

## The places that matter

| Place | What | Record |
| --- | --- | --- |
| Mount Neriton | the wooded mountain, seen from the sea on [[voyage/day-171-ithaca-in-sight]] | [[ithaca/island/neriton]] |
| Harbour of Phorcys | sheltered bay with the cave and the olive | [[ithaca/island/harbour-of-phorcys]] |
| Raven's Rock | the crag near the swineherd's yard | [[ithaca/island/ravens-rock]] |
| Spring Arethusa | water for the swine | [[ithaca/island/arethusa]] |
| The swine yard | [[people/eumaeus]]'s steading | [[ithaca/island/eumaeus-yard]] |
| The farm | [[people/laertes]]'s, in the uplands | [[ithaca/island/laertes-farm]] |
| The town | the hall, the harbour, the spring the townsfolk use | [[ithaca/hall/plan]] |

## A caution

This is the island a man carries in his head after twenty years. Each line is a starting point. The first job on landing is to check, not to recognise; see [[ithaca/questions-on-landing]].

Hub: [[ithaca/_index]].`,
    links: ["ithaca/island/neriton.md", "ithaca/island/harbour-of-phorcys.md", "ithaca/island/ravens-rock.md", "ithaca/island/arethusa.md", "ithaca/island/eumaeus-yard.md", "ithaca/island/laertes-farm.md", "ithaca/hall/plan.md", "ithaca/questions-on-landing.md", "ithaca/_index.md", "voyage/day-171-ithaca-in-sight.md", "people/eumaeus.md", "people/laertes.md"],
    fields: { confidence: "remembered" },
  },
  {
    path: "ithaca/island/neriton.md",
    title: "Mount Neriton",
    type: "place-note",
    created: "2019-08-20",
    updated: "2025-11-02",
    status: "active",
    tags: ["island", "remembered", "navigation"],
    places: ["place:ithaca"],
    summary: "The wooded mountain, its leaves always moving. The first thing of Ithaca you see from the sea, and the thing I saw on day 171 before I slept.",
    body: `Remembered.

## What it is

The high, wooded mountain that is Ithaca's shape from the water. The trees on it shake in any wind, so the whole mountain seems to move when nothing else is moving.

## As a seamark

From the south and west it is the first of the island to rise. A man who knows its line can tell where on the coast he is from a long way out. I knew it well enough to be certain on day 171, from Aeolus's island, when it came up out of the sea after nine days and nights at the sheet. I slept then, for the first time in nine days. That was the sleep in which the crew opened the bag. See [[voyage/day-171-ithaca-in-sight]], [[decisions/keep-the-helm-nine-days]], [[crew/aeolia-bag]] and [[voyage/_index]].

## Lesson filed against it

The mountain is not the harbour. Sighting it is not arriving. I have entered a landfall as done once before on the strength of a mountain, and I will not do it again.

## On landing

Whether anyone has felled the woods on it. Twenty years of a household with no master and timber wanted for ships may have done it. A mountain is the hardest landmark to change and the slowest to come back.

See [[ithaca/island/geography]].`,
    links: ["voyage/_index.md", "ithaca/island/geography.md", "ithaca/_index.md", "voyage/day-171-ithaca-in-sight.md", "decisions/keep-the-helm-nine-days.md", "crew/aeolia-bag.md"],
    fields: { confidence: "remembered", seen_last: "day 171, from the sea" },
  },
  {
    path: "ithaca/island/harbour-of-phorcys.md",
    title: "The harbour of Phorcys",
    type: "place-note",
    created: "2019-08-20",
    updated: "2025-11-02",
    status: "active",
    tags: ["island", "remembered", "navigation"],
    places: ["place:ithaca"],
    summary: "A bay between two steep headlands where a ship lies without a cable. An olive tree at its head, and the cave of the nymphs with two entrances.",
    body: `Remembered.

## The bay

Named for the Old Man of the Sea. Two headlands, sheer to seaward, sloping down towards the harbour, keep the swell out. A ship that gets inside can lie there without a mooring line ([[knowledge/mooring]]). It is not the town harbour and is out of sight of it.

## At its head

- A long-leaved olive tree.
- Near it, a cave sacred to the nymphs, the Naiads. Inside, mixing bowls and jars of stone, where bees store honey, and great looms of stone where the nymphs weave. Water runs all year.
- **Two entrances.** One faces north, by which men go in. One faces south, and that one is for the gods; men do not use it.

## Why this record exists

Because it is the place on Ithaca where a man could come ashore with no one in the town knowing, put what he carried in a cave nobody disturbs, and walk inland to the swineherd's yard, to [[people/eumaeus]], without passing the hall.

Not a plan; a fact about the coast ([[knowledge/reading-a-coast]]). See [[ithaca/island/eumaeus-yard]] and [[ithaca/island/geography]].`,
    links: ["ithaca/island/eumaeus-yard.md", "ithaca/island/geography.md", "ithaca/_index.md", "knowledge/mooring.md", "people/eumaeus.md", "knowledge/reading-a-coast.md"],
    fields: { confidence: "remembered", out_of_sight_of_town: true },
  },
  {
    path: "ithaca/island/ravens-rock.md",
    title: "Raven's Rock",
    type: "place-note",
    created: "2019-08-20",
    updated: "2025-11-02",
    status: "active",
    tags: ["island", "remembered"],
    people: ["person:eumaeus"],
    places: ["place:ithaca"],
    summary: "The crag near the far end of the island where the swine are grazed, above the spring Arethusa.",
    body: `Remembered.

## Where

At the far end of the island from the town, inland. A high rock that ravens nest on, which is how it got its name and all that the name means. You see the birds there wheeling at dusk, before you see the rock itself.

## What is there

- The grazing ground where the swine are driven to feed on acorns and to drink.
- The spring Arethusa below it: [[ithaca/island/arethusa]].
- Within a short walk: the yard of [[people/eumaeus]], [[ithaca/island/eumaeus-yard]].

## Distance

Far enough from the town that the hall does not see who comes and goes; near enough that Eumaeus can drive a hog in every day. That balance is why the yard has been able to keep its own counsel for four years while feeding the suitors daily.

## On landing

A man walking from the harbour of Phorcys to the yard passes this way. The path is twenty years old in my memory and may not be the path now. See [[ithaca/island/geography]].`,
    links: ["ithaca/island/arethusa.md", "people/eumaeus.md", "ithaca/island/eumaeus-yard.md", "ithaca/island/geography.md", "ithaca/_index.md"],
    fields: { confidence: "remembered" },
  },
  {
    path: "ithaca/island/arethusa.md",
    title: "The spring Arethusa",
    type: "place-note",
    created: "2019-08-20",
    updated: "2025-11-02",
    status: "active",
    tags: ["island", "remembered", "water"],
    places: ["place:ithaca"],
    summary: "The spring below Raven's Rock where the swine drink. Water all year, which on this island is not a small thing.",
    body: `Remembered.

## The spring

Below [[ithaca/island/ravens-rock]], on the swineherd's ground. Dark water, cold, steady through summer. The swine drink there after acorns; it is what makes that end of the island good for them.

## Why water is filed at all

Seven years on an island where water was never short ([[ogygia/island/springs]]) have not made me forget an island where it can be. Ithaca is rock. A spring that runs all year is a fixed point: people come to it at known hours, animals are driven to it, and anyone wanting to find a man who keeps herds goes to the water first.

There is another spring nearer the town, with a stone basin and an altar to the nymphs, where the townsfolk draw. That is a different one, and the hall's women fetch from it.

## On landing

- [ ] Is it still running? Twenty years of the climate may say so, or not.
- [ ] Who drinks there now: only the household's swine, or other men's herds too?

A note made on Ogygia, where the springs have never failed: I mean this record more than it reads.

See [[ithaca/island/geography]].`,
    links: ["ithaca/island/ravens-rock.md", "ithaca/island/geography.md", "ithaca/_index.md", "ogygia/island/springs.md"],
    fields: { confidence: "remembered" },
  },
  {
    path: "ithaca/island/eumaeus-yard.md",
    title: "The swine yard",
    type: "place-note",
    created: "2019-08-20",
    updated: "2026-06-04",
    status: "active",
    tags: ["island", "herds", "household"],
    people: ["person:eumaeus"],
    places: ["place:ithaca"],
    summary: "Eumaeus's steading near Raven's Rock: a stone-walled court, twelve sties, four dogs, and the herds he has kept together against the hall.",
    body: `Remembered, with one report since.

## As built

[[people/eumaeus]] built it himself, from stones he hauled, with no help from his mistress or my father, [[people/laertes]]. A high wall round a broad court, topped with wild pear thorn. Outside it a palisade of split oak, close-set. Inside, **twelve sties** side by side, about fifty sows in each, farrowing; the boars sleep outside the sties. Four dogs, like wild beasts, which he reared himself.

## Reported, day 3614

- The boars are far fewer than the sows, because every day he sends the best of them to the hall.
- He has hired a man to help him, out of his own means, without telling anyone.
- He grieves for me in front of strangers, which the report mentions as if it were remarkable. It is not, from him.

## Why this place

It is the one house on the island where I would expect to be taken in by a man who has not recognised me, simply because a stranger has come to the door ([[knowledge/guest-friendship]]). That is his character, not my wish. It is also far from the hall.

Line in the ledger: [[ithaca/stores/swine]]. Location: [[ithaca/island/ravens-rock]].`,
    links: ["people/eumaeus.md", "ithaca/stores/swine.md", "ithaca/island/ravens-rock.md", "ithaca/_index.md", "people/laertes.md", "knowledge/guest-friendship.md"],
    fields: { confidence: "mixed", reported: "2026-06-04", sties: 12, dogs: 4 },
  },
  {
    path: "ithaca/island/philoetius-cattle.md",
    title: "Philoetius and the cattle",
    type: "place-note",
    created: "2019-08-20",
    updated: "2026-06-04",
    status: "active",
    tags: ["herds", "remembered"],
    places: ["place:ithaca"],
    summary: "The cowherd I set over the cattle on the mainland when he was a boy. The herds have grown under him, and he has to ferry them over for the suitors.",
    body: `Remembered: I set [[people/philoetius]] over my cattle in the country of the Cephallenians on the mainland when he was still a boy. He was steady then.

## Reported, day 3614, through Eumaeus

- The cattle have increased under him beyond what any man could ask. The report says they have spread like grain.
- He is made to bring them over in boats for the suitors' sacrifices, and does it because he must.
- He has thought about driving the herds off to some other lord's country, out of reach of the hall, and has not, because he keeps hoping I will come back. He is reported to have said so to Eumaeus.

## How that sits against the ledger

Ninety-six head consumed of seven hundred and twenty held. The lightest line, partly because of the crossing, and from this report partly because of him. See [[ithaca/stores/cattle]].

## On landing

He and [[people/eumaeus]] are the two herdsmen I would trust first. Two is not many. Note also that he has not been told anything, and that a man who has waited this long should be told by me, in person, and not by rumour. See [[ithaca/homecoming-checklist]].`,
    links: ["ithaca/stores/cattle.md", "ithaca/homecoming-checklist.md", "ithaca/_index.md", "people/philoetius.md", "people/eumaeus.md"],
    fields: { confidence: "mixed", reported: "2026-06-04", role: "cowherd" },
  },
  {
    path: "ithaca/island/laertes-farm.md",
    title: "My father's farm",
    type: "place-note",
    created: "2019-08-20",
    updated: "2025-05-07",
    status: "active",
    tags: ["island", "farm", "household"],
    people: ["person:laertes"],
    places: ["place:ithaca"],
    summary: "The upland farm my father worked and improved: house, outbuildings, the orchard and the vineyard. He lives there now, with an old servant woman and Dolius's family.",
    body: `Remembered, and reported in part on day 3221.

## As I left it

A good farm my father won by his own labour long ago. The house, with sheds round it where the servants eat and sit and sleep. The orchard and the vineyard, terraced, below and around: [[ithaca/island/orchard]]. A walled garden.

## Who is there, as reported

- [[people/laertes]], who has not come to the town in years.
- An old woman, a Sicilian, who looks after him.
- [[people/dolius]], an old servant of the house, and his sons, working the land.

## How he lives, as reported

Day 620, from my mother, [[people/anticleia]]: no bed, no cloak or rugs; in winter he sleeps where the servants sleep, in the ashes near the fire; in summer on fallen leaves on the slope of the vineyard. Grieving.

Day 3221: unchanged, except that he is older and weaker, and has stopped asking for news.

## Why it matters

He is the one person on the island I owe the most explanation to and can give the least. The farm is also out of the way and loyal. Both are true.

See [[ithaca/news/day-3221-laertes]] and [[ithaca/island/geography]].`,
    links: ["ithaca/island/orchard.md", "people/laertes.md", "ithaca/news/day-3221-laertes.md", "ithaca/island/geography.md", "ithaca/_index.md", "people/dolius.md", "people/anticleia.md"],
    fields: { confidence: "mixed", reported: "2025-05-07" },
  },
  {
    path: "ithaca/island/orchard.md",
    title: "The trees he gave me",
    type: "inventory",
    created: "2019-08-20",
    updated: "2025-05-07",
    status: "active",
    tags: ["farm", "remembered"],
    people: ["person:laertes"],
    places: ["place:ithaca"],
    summary: "Thirteen pear, ten apple, forty fig, fifty rows of vines. Given me by my father when I was a boy walking the orchard behind him.",
    body: `Remembered, exactly, because I asked him for them one by one.

When I was small I followed my father through the orchard and asked him the name of every tree, and he told me, and gave them to me.

| Tree | Count |
| --- | ---: |
| Pear | 13 |
| Apple | 10 |
| Fig | 40 |
| Vines, in rows | 50 rows |

He said each row of vines ripened at a different time, so there would be grapes through the whole of the season.

## Why it is exact

It is the one inventory in this folder that I am certain of. Not from a report; I was there and the numbers were said to me as gifts ([[knowledge/guest-gifts]]). A man can claim to be anyone. He cannot know these unless he was that boy.

## Standing

Still his. Still mine. Whether the trees are standing after twenty years and an old man's care, the report of day 3221 does not say. A fig tree outlives most things. See [[ithaca/island/laertes-farm]] and [[people/laertes]].

Kept off any list of things to say to anyone but him.`,
    links: ["ithaca/island/laertes-farm.md", "people/laertes.md", "ithaca/_index.md", "knowledge/guest-gifts.md"],
    fields: { confidence: "remembered", pear: 13, apple: 10, fig: 40, vine_rows: 50 },
  },
  {
    path: "ithaca/island/the-bed.md",
    title: "The bed",
    type: "private",
    created: "2019-08-20",
    updated: "2026-07-12",
    status: "sealed",
    tags: ["household", "private", "remembered"],
    people: ["person:penelope"],
    places: ["place:ithaca"],
    summary: "I built our bed and the room around it myself. How it was made is known to Penelope, to me and to one servant. The details are not written here.",
    body: `Remembered. Deliberately incomplete.

## What can be written

- I built our bed myself, with my own hands, and built the bedroom around it.
- There is something about how it is made that cannot be undone without destroying it. That is the whole of what I will record.
- Three people know: [[people/penelope]], me, and one servant woman who came with Penelope from her father's house, the house of [[people/icarius]], and keeps the door of the room.
- Nobody else has ever been in that room.

## What is not written

The thing itself. How the bed stands, what it is made from, what it is fixed to. This device has passed through other hands before and may again before it reaches Ithaca, if it does. A secret that is known to two people and written in a third place is known to three.

## What it is for

If I come home in a shape nobody recognises, and Penelope is as careful as I know her to be, she will not take my word or my scar ([[knowledge/wounds]]) or the boy's. She will test me with something only the two of us know. This is that thing. I will not spoil it by having written it down.

Hub: [[ithaca/_index]].`,
    links: ["people/penelope.md", "ithaca/_index.md", "people/icarius.md", "knowledge/wounds.md"],
    fields: { confidence: "remembered", known_to: 3, recorded: false },
  },

  /* ------------------------------------------------------- departure */
  {
    path: "ithaca/departure-instructions.md",
    title: "What I told her when I left",
    type: "decision",
    created: "2019-08-03",
    updated: "2026-07-04",
    status: "closed",
    tags: ["household", "remembered", "judgement"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ithaca", "place:troy"],
    summary: "If I did not come back, when the boy had a beard she should marry whom she chose and leave the house. The boy has a beard.",
    body: `Remembered word for word, near enough. The one instruction I left her that is still in force.

> I do not think all of us will come home from Troy. The Trojans are fighters. I cannot say whether a god will bring me back or I will fall there. Look after everything here. Look after my father and mother as you do now, more so while I am away. And when you see the beard on the boy's face, marry whom you will, and leave this house.

## Status

- Given: twenty years ago, at the harbour.
- Condition: the beard on the boy's face.
- Condition met: yes. He is twenty, and reported to have spoken in assembly as a man; see [[ithaca/telemachus/assembly]].

## What that means

By my own instruction she is free to choose, and has been for some time. If she were to do it, she would be doing what I told her to do. Every delay since the condition was met has been hers, against my instruction and in my favour.

I keep wanting to amend this record. There is no one to amend it with.

## Linked

[[ithaca/household/penelope-standing]]; [[people/penelope]]; [[oaths/promise-to-penelope]]; and [[people/laertes]] and [[people/anticleia]], whom she was asked to look after.`,
    links: ["ithaca/telemachus/assembly.md", "ithaca/household/penelope-standing.md", "people/penelope.md", "ithaca/_index.md", "oaths/promise-to-penelope.md", "people/laertes.md", "people/anticleia.md"],
    fields: { confidence: "remembered", condition: "the boy's beard", condition_met: true },
  },

  /* ------------------------------------------------------------- news */
  {
    path: "ithaca/news/log.md",
    title: "News from Ithaca",
    type: "log",
    created: "2025-05-07",
    updated: "2026-07-11",
    status: "active",
    tags: ["news", "log", "reported"],
    people: ["person:penelope", "person:telemachus", "person:laertes", "person:eumaeus", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Every report from home, dated by when it reached me. Newest first.",
    body: `Dated by arrival. The event date is inside each entry where known. Each entry is filed exactly as it came and not tidied afterwards.

| Arrived | Entry |
| --- | --- |
| 2026-07-11, day 3651 | [[omens/day-3651-eagle]] |
| 2026-07-09, day 3649 | [[ithaca/news/day-3649-sparta]] |
| 2026-07-08, day 3648 | [[ithaca/news/day-3648-medon]] |
| 2026-07-07, day 3647 | [[ithaca/news/day-3647-hermes]] |
| 2026-07-06, day 3646 | [[ithaca/news/day-3646-ambush]] |
| 2026-07-06, day 3646 | [[ithaca/news/day-3646-pylos]] |
| 2026-07-04, day 3644 | [[ithaca/news/day-3644-assembly]] |
| 2026-06-30, day 3640 | [[ithaca/news/day-3640-shroud-finished]] |
| 2026-06-04, day 3614 | [[ithaca/news/day-3614-eumaeus]] |
| 2025-11-02, day 3400 | [[ithaca/news/day-3400-the-hall]] |
| 2025-05-07, day 3221 | [[ithaca/news/day-3221-laertes]] |

Before that, one line on day 2400, the first news of any kind to reach this island: men in the hall, courting her, and no figures. It is in [[journal/day-2400]]. Before that, nothing; and before that, my mother at the house of the dead on day 620: [[ithaca/household/anticleia]], [[voyage/day-620-acheron]].

## What the rhythm says

Eleven entries in fourteen months, eight of them in the last twelve days, two on [[journal/day-3646]] alone. Somebody, somewhere, has started paying attention to this island and that one. I record that as a pattern and not as a reason.

Hub: [[ithaca/_index]]. Method: [[ithaca/reported-and-remembered]].`,
    links: ["omens/day-3651-eagle.md", "ithaca/news/day-3649-sparta.md", "ithaca/news/day-3648-medon.md", "ithaca/news/day-3647-hermes.md", "ithaca/news/day-3646-ambush.md", "ithaca/news/day-3646-pylos.md", "ithaca/news/day-3644-assembly.md", "ithaca/news/day-3640-shroud-finished.md", "ithaca/news/day-3614-eumaeus.md", "ithaca/news/day-3400-the-hall.md", "ithaca/news/day-3221-laertes.md", "journal/day-2400.md", "ithaca/household/anticleia.md", "ithaca/_index.md", "ithaca/reported-and-remembered.md", "voyage/day-620-acheron.md", "journal/day-3646.md"],
    fields: { confidence: "reported", entries: 11 },
  },
  {
    path: "ithaca/news/day-3221-laertes.md",
    title: "Day 3,221: my father, on the farm",
    type: "news",
    created: "2025-05-07",
    updated: "2025-05-07",
    status: "filed",
    tags: ["news", "reported", "farm"],
    people: ["person:laertes"],
    places: ["place:ithaca"],
    summary: "The first word of my father in six years on this island. Laertes lives on the upland farm, does not come to town, and has stopped asking.",
    body: `Arrived day 3221. Second-hand; the source did not give his own name, and I did not press.

## The report

- [[people/laertes]] is alive.
- He lives on the upland farm and has not come down to the town for years.
- An old woman looks after him; [[people/dolius]] and his sons work the land.
- He works the vineyard himself, in old patched clothes, with leather guards on his shins against the thorns and gloves on his hands.
- He has stopped asking whether there is news of me.

## Against what I knew

Agrees with what my mother, [[people/anticleia]], told me on day 620. Older now. No mention of my mother; her death is not news to anyone there, only to me eight years ago.

## What I did with it

Updated [[people/laertes]]. Opened [[ithaca/island/laertes-farm]]. Wrote nothing else for a day.

## What it does not say

Anything about Penelope, the boy, or the hall. It was the first report since the one line on day 2400 ([[journal/day-2400]]), and it was about an old man and his vines. I did not know then that it was the first of a series.

Log: [[ithaca/news/log]].`,
    links: ["people/laertes.md", "ithaca/island/laertes-farm.md", "ithaca/news/log.md", "ithaca/_index.md", "people/dolius.md", "people/anticleia.md", "journal/day-2400.md"],
    fields: { confidence: "reported", day: 3221, source: "second-hand, unnamed" },
  },
  {
    path: "ithaca/news/day-3400-the-hall.md",
    title: "Day 3,400: the hall",
    type: "news",
    created: "2025-11-02",
    updated: "2025-11-02",
    status: "filed",
    tags: ["news", "reported", "suitors"],
    people: ["person:penelope", "person:antinous"],
    places: ["place:ithaca"],
    summary: "The first full report of the suitors: 108 of them, the stores, the loom and its discovery, the fifty women and the twelve.",
    body: `Arrived day 3400; my own entry that day is [[journal/day-3400]]. The longest single report so far. Most of the folder was opened from it.

## As it came

1. Penelope is alive and has not remarried.
2. Men from Dulichium, Same, Zacynthus and Ithaca have been sitting in the hall for over three years, courting her and living off the house. One hundred and eight of them.
3. The stores are being drawn down. The figures came by line.
4. She held them off for three years with a shroud for [[people/laertes]], unweaving it at night. She was found out in the fourth year, and must now finish it.
5. Of the fifty women in the house, twelve have gone over to the suitors.
6. The singer, [[people/phemius]], is made to sing for them.

## What I opened

[[ithaca/suitors/roster]], [[ithaca/stores/drawdown]], [[ithaca/loom/shroud]], [[ithaca/household/women-servants]], [[ithaca/household/phemius]].

## Note on dates

"Over three years" on day 3400 fits a start near day 2192. The figure of 1,460 days used since is four years from that start to today.

Log: [[ithaca/news/log]].`,
    links: ["ithaca/suitors/roster.md", "ithaca/stores/drawdown.md", "ithaca/loom/shroud.md", "ithaca/household/women-servants.md", "ithaca/household/phemius.md", "ithaca/news/log.md", "ithaca/_index.md", "journal/day-3400.md", "people/laertes.md", "people/phemius.md"],
    fields: { confidence: "reported", day: 3400 },
  },
  {
    path: "ithaca/news/day-3614-eumaeus.md",
    title: "Day 3,614: from the swine yard",
    type: "news",
    created: "2026-06-04",
    updated: "2026-06-04",
    status: "filed",
    tags: ["news", "reported", "herds"],
    people: ["person:eumaeus"],
    places: ["place:ithaca"],
    summary: "Eumaeus's count of the herds, the hog sent in every day, the goatherd gone over, and Philoetius waiting with the cattle.",
    body: `Arrived day 3614. Source: [[people/eumaeus]], reported through a third party. The figures are his.

## The report

- The swine line confirmed: 1,180 consumed of 1,800. See [[ithaca/stores/swine]].
- He sends the best fattened hog to the hall every day, because they demand it.
- He keeps the sties as I remember them, twelve, and has hired a man of his own.
- The goatherd who supplies the hall has turned; he eats with the suitors. See [[ithaca/stores/goats]].
- [[people/philoetius]], with the cattle on the mainland, has grown the herds and is close to driving them off out of reach, and has not, because he waits for me. See [[ithaca/island/philoetius-cattle]].
- He talks about me to strangers who come to the yard. He does not believe the ones who claim to have news.

## What I did with it

Updated the stores lines and [[people/eumaeus]].

## What I noticed

He does not believe the strangers. A man who arrives at his door claiming to know where I am will be fed, housed ([[knowledge/guest-friendship]]) and not believed. That is useful to know, and I find it moving, and both of those belong in the record.

Log: [[ithaca/news/log]].`,
    links: ["people/eumaeus.md", "ithaca/stores/swine.md", "ithaca/stores/goats.md", "ithaca/island/philoetius-cattle.md", "ithaca/news/log.md", "ithaca/_index.md", "people/philoetius.md", "knowledge/guest-friendship.md"],
    fields: { confidence: "reported", day: 3614, source: "Eumaeus, relayed" },
  },
  {
    path: "ithaca/news/day-3640-shroud-finished.md",
    title: "Day 3,640: the shroud finished, the pressure on",
    type: "news",
    created: "2026-06-30",
    updated: "2026-06-30",
    status: "filed",
    tags: ["news", "reported", "loom"],
    people: ["person:penelope", "person:laertes"],
    places: ["place:ithaca"],
    summary: "The shroud is off the loom. Her father and brothers urge her to marry. The suitors say they will not leave until she chooses.",
    body: `Arrived day 3640. My own entry that day: [[journal/day-3640]].

## The report

- The shroud for [[people/laertes]] is finished and off the loom. It is said to be fine work, like the sun or the moon in the light.
- Her father, [[people/icarius]], and her brothers are pressing her to marry. The report puts it plainly: they think the waiting is over.
- The suitors say they will not go back to their own lands until she chooses one of them.
- She is reported as sleeping badly and spending the days in her rooms.

## What it changes

The loom was her one formal reason to delay. It is gone. Whatever holds the suitors off now is her standing and nothing else. See [[ithaca/household/penelope-standing]] and [[ithaca/loom/shroud]].

## What I did with it

Updated [[people/penelope]]. Read [[ithaca/departure-instructions]] again. Did not change it.

Log: [[ithaca/news/log]].`,
    links: ["people/laertes.md", "ithaca/household/penelope-standing.md", "ithaca/loom/shroud.md", "people/penelope.md", "ithaca/departure-instructions.md", "ithaca/news/log.md", "ithaca/_index.md", "journal/day-3640.md", "people/icarius.md"],
    fields: { confidence: "reported", day: 3640 },
  },
  {
    path: "ithaca/news/day-3644-assembly.md",
    title: "Day 3,644: the assembly, and the boy has sailed",
    type: "news",
    created: "2026-07-04",
    updated: "2026-07-04",
    status: "filed",
    tags: ["news", "reported", "telemachus"],
    people: ["person:telemachus", "person:antinous"],
    places: ["place:ithaca", "place:pylos"],
    summary: "Telemachus called the first assembly since I left, lost the argument, borrowed a ship, and sailed for Pylos the same night.",
    body: `Arrived day 3644. Events of day 3642. The fastest report yet: two days.

## The report

- [[people/telemachus]] called an assembly, the first on the island in twenty years.
- He asked the town to restrain the suitors. [[people/antinous]] answered him and the town did nothing.
- An omen of two eagles over the assembly: [[omens/day-3644-two-eagles]].
- He asked for a ship and twenty men to go to Pylos and Sparta for news of me. Refused by the suitors; found anyway.
- [[people/eurycleia]] provisioned the ship from the storeroom and was sworn to silence.
- He sailed that night. His mother does not know.

## What I opened

[[ithaca/telemachus/assembly]], [[ithaca/telemachus/ship-and-crew]].

## What I did with it

Walked the shore for an hour. Then filed it, and wrote [[journal/day-3644]].

He has gone looking for news of me in the direction I am not. He will find out more about me in Sparta than I have been able to send him in seven years. I cannot decide whether that is a failure of mine. It is.

Log: [[ithaca/news/log]].`,
    links: ["people/telemachus.md", "people/antinous.md", "ithaca/telemachus/assembly.md", "ithaca/telemachus/ship-and-crew.md", "ithaca/news/log.md", "ithaca/_index.md", "omens/day-3644-two-eagles.md", "people/eurycleia.md", "journal/day-3644.md"],
    fields: { confidence: "reported", day: 3644, event_day: 3642 },
  },
  {
    path: "ithaca/news/day-3646-pylos.md",
    title: "Day 3,646: at Pylos",
    type: "news",
    created: "2026-07-06",
    updated: "2026-07-06",
    status: "filed",
    tags: ["news", "reported", "telemachus"],
    people: ["person:telemachus", "person:nestor"],
    places: ["place:pylos"],
    summary: "Telemachus reached Pylos and was received by Nestor, who knew how the fleet left Troy and nothing after. Sent on overland to Sparta.",
    body: `Arrived day 3646. Events of days 3643 and 3644.

## The report

- The ship reached Pylos at dawn, day 3643, after a fair wind through the night.
- [[people/nestor]] and his people were on the beach at a sacrifice. They took the boy in.
- Nestor told him about the quarrel after Troy and the return of the others. He has no news of me after the fleet divided.
- The boy left the ship and crew at Pylos and set off overland by chariot, day 3644, with one of Nestor's sons, [[people/peisistratus]], driving.

## Same day

The same report carried an omen at Pylos: a hawk crossing to the right of the ship, carrying, and letting nothing fall. Filed on its own at [[omens/day-3646-hawk]], without interpretation. I leave the connection undrawn.

## What it changes

He is safe, and further from the strait than he was. The ship is at Pylos and will have to come home past Asteris. See [[ithaca/telemachus/route]].

Log: [[ithaca/news/log]]. Journal: [[journal/day-3646]].`,
    links: ["people/nestor.md", "omens/day-3646-hawk.md", "ithaca/telemachus/route.md", "ithaca/news/log.md", "ithaca/_index.md", "people/peisistratus.md", "journal/day-3646.md"],
    fields: { confidence: "reported", day: 3646, event_day: 3643 },
  },
  {
    path: "ithaca/news/day-3646-ambush.md",
    title: "Day 3,646: a ship sent to Asteris",
    type: "news",
    created: "2026-07-06",
    updated: "2026-07-06",
    status: "filed",
    tags: ["news", "reported", "danger"],
    people: ["person:antinous", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "The suitors learned the boy had gone when Noemon asked for his ship back. Antinous asked for a fast ship and twenty men to wait for him in the strait.",
    body: `Arrived day 3646. Same-day report.

## The report

- [[people/noemon]] asked openly in the town for his ship back. That is how the suitors learned [[people/telemachus]] had sailed.
- They were reported as astonished: they had thought he was on the farm, or with the swineherd.
- [[people/antinous]], angry, asked for a fast ship and twenty men to lie in wait for him in the strait between Ithaca and Same.
- They chose the men and the ship went out to Asteris.

## What I opened

[[ithaca/suitors/ambush-ship]] and [[ithaca/telemachus/return-risk]].

## What I did with it

Nothing, because there is nothing. I have no ship, no crew and no leave to go, so there are no days to count. The boy will be home, or not, long before I am anywhere near the strait.

## A line for the record

I have lost six hundred men on the way home. If the first man of mine to die after them is my son, on his way home, it will be because he went looking for me.

Log: [[ithaca/news/log]]. Journal: [[journal/day-3646]].`,
    links: ["people/telemachus.md", "people/antinous.md", "ithaca/suitors/ambush-ship.md", "ithaca/telemachus/return-risk.md", "ithaca/news/log.md", "ithaca/_index.md", "people/noemon.md", "journal/day-3646.md"],
    fields: { confidence: "reported", day: 3646 },
  },
  {
    path: "ithaca/news/day-3647-hermes.md",
    title: "Day 3,647: what Hermes did not say",
    type: "news",
    created: "2026-07-07",
    updated: "2026-07-07",
    status: "filed",
    tags: ["news", "gods", "sources"],
    people: ["person:calypso", "person:athena", "person:penelope"],
    places: ["place:ogygia", "place:ithaca"],
    summary: "Hermes came to Calypso with Zeus's order that I be let go. He said nothing about Ithaca, which is itself a kind of report.",
    body: `Arrived day 3647. Not a report from Ithaca, strictly; filed here because of what it implies.

## What happened

[[people/hermes]] came to [[people/calypso]] with an order from [[people/zeus]]: that I be let go home. Not escorted; let go. She swore she would not harm me ([[oaths/calypso-no-harm]]) and would help me build a vessel. The raft was begun the next day. Her side of it: [[ogygia/build/day-3647-the-order]].

## What he did not say

Anything about the household, the suitors, the boy, my wife. He came for a decision about me and delivered it. Nothing else.

## How to read that

The gods have argued about me, and something has changed, and the change came the same week the boy sailed. I note the coincidence. I note that [[people/athena]] takes an interest in my house. I do not file a theory.

What I take as fact: the household is standing, or I would expect even Hermes to have mentioned it. That is weak evidence and I have marked it so.

## What I did with it

Began the raft: [[voyage/ogygia/raft]]. Kept this log open.

Log: [[ithaca/news/log]].`,
    links: ["oaths/calypso-no-harm.md", "people/calypso.md", "people/athena.md", "voyage/ogygia/raft.md", "ithaca/news/log.md", "ithaca/_index.md", "people/hermes.md", "people/zeus.md", "ogygia/build/day-3647-the-order.md"],
    fields: { confidence: "inferred", day: 3647, source: "Hermes, by omission" },
  },
  {
    path: "ithaca/news/day-3648-medon.md",
    title: "Day 3,648: Penelope knows",
    type: "news",
    created: "2026-07-08",
    updated: "2026-07-08",
    status: "filed",
    tags: ["news", "reported", "household"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Medon overheard the ambush plan and told Penelope. She learned in one sentence that her son had sailed and that men were going to kill him.",
    body: `Arrived day 3648. Events of day 3646.

## The report

- [[people/medon]] the herald was outside the courtyard wall while the suitors planned the ship. He went in to [[people/penelope]] and told her.
- She had not known [[people/telemachus]] had gone at all.
- She sank down on the threshold of her room and could not stand. The women wept round her.
- She asked [[people/eurycleia]], who admitted she had known, and had provisioned the ship, and had been sworn.
- She did not punish her.
- She prayed and slept, and in her sleep had a dream that her son would return. She was reported as calmer after it.

## Against what I knew

The silence Eurycleia swore to was meant to last eleven or twelve days. It lasted four.

## What I did with it

Opened [[ithaca/household/medon]]. Updated [[ithaca/household/eurycleia]].

Nothing about the dream is filed as evidence. It is filed because it is what she has.

Log: [[ithaca/news/log]].`,
    links: ["people/penelope.md", "people/telemachus.md", "ithaca/household/medon.md", "ithaca/household/eurycleia.md", "ithaca/news/log.md", "ithaca/_index.md", "people/medon.md", "people/eurycleia.md"],
    fields: { confidence: "reported", day: 3648, event_day: 3646, source: "Medon, relayed" },
  },
  {
    path: "ithaca/news/day-3649-sparta.md",
    title: "Day 3,649: at Sparta",
    type: "news",
    created: "2026-07-09",
    updated: "2026-07-09",
    status: "filed",
    tags: ["news", "reported", "telemachus"],
    people: ["person:telemachus", "person:menelaus", "person:calypso"],
    places: ["place:sparta", "place:ogygia"],
    summary: "Telemachus reached Sparta and Menelaus told him I am alive, held on an island by Calypso. He is the first at home to know where I am.",
    body: `Arrived day 3649. Events of day 3645 onward.

## The report

- [[people/telemachus]] arrived at Sparta at evening, day 3645, after two days in the chariot.
- [[people/menelaus]] and [[people/helen]] received him. He was recognised by his likeness to me before he gave his name.
- Menelaus told him what the Old Man of the Sea, [[people/proteus]], had told him in Egypt: that I am alive, on an island, in the halls of [[people/calypso]], held there against my will, with no ship and no crew.
- He has been offered horses and a chariot as gifts. He asked for something he could carry on a ship instead, because Ithaca is no place for horses.

## Against what I knew

All of it correct as of the day it was said. The no-ship part becomes untrue today.

## What it changes

He knows I am alive. So, therefore, will Penelope when he is home. So, therefore, will the hall, eventually. Every one of those has consequences that run on a clock I do not control.

What he asked for instead of horses is the thing that told me most about him. He knows his island.

Detail at [[ithaca/telemachus/what-he-heard]]. Log: [[ithaca/news/log]]. Journal: [[journal/day-3649]].`,
    links: ["people/telemachus.md", "people/menelaus.md", "people/calypso.md", "ithaca/telemachus/what-he-heard.md", "ithaca/news/log.md", "ithaca/_index.md", "people/helen.md", "people/proteus.md", "journal/day-3649.md"],
    fields: { confidence: "reported", day: 3649, event_day: 3645 },
  },

  /* ------------------------------------------------------- on landing */
  {
    path: "ithaca/questions-on-landing.md",
    title: "Questions to ask on landing",
    type: "checklist",
    created: "2025-11-02",
    updated: "2026-07-12",
    status: "open",
    tags: ["landing", "questions", "household"],
    people: ["person:penelope", "person:telemachus", "person:eumaeus", "person:laertes", "person:argos"],
    places: ["place:ithaca"],
    summary: "Every question the reports have raised and cannot answer. To be asked in person, in order, and of the right person.",
    body: `Grouped by whom to ask. Nothing on this list is answered from here.

## Eumaeus, first

- [ ] Is the boy home? Which way did he come?
- [ ] Is the ship still at Asteris?
- [ ] Who drives the goats in now, and is the report about him true? [[ithaca/stores/goats]]
- [ ] Who has the sheep? [[ithaca/stores/sheep]]
- [ ] Where do the suitors from Zacynthus lodge, and who leads them? [[ithaca/suitors/zacynthus]]
- [ ] Is [[people/argos]] alive?

## Telemachus

- [ ] Who sailed with him? Who was Mentor? [[ithaca/household/mentor]], [[people/mentor]]
- [ ] What did [[people/menelaus]] tell him, in his own words?

## Eurycleia

- [ ] The keys, the counts, and whether the twelve jars are in the 812. [[ithaca/stores/wine]]
- [ ] Which twelve, and how long, and whether any were forced. [[ithaca/household/the-twelve]]

## Penelope, and only her

- [ ] Who told about the loom. [[ithaca/loom/discovery]]
- [ ] Whether she agrees with the count of twelve.

## The hall, by looking

- [ ] Does the side door still bar? [[ithaca/hall/plan]]
- [ ] Are the arms still on the walls? [[ithaca/hall/weapons]]
- [ ] Is Medon still there? [[ithaca/household/medon]]

## Laertes

- [ ] Are the trees standing? [[ithaca/island/orchard]], [[people/laertes]]

Method: [[ithaca/reported-and-remembered]].`,
    links: ["ithaca/stores/goats.md", "ithaca/stores/sheep.md", "ithaca/suitors/zacynthus.md", "people/argos.md", "ithaca/household/mentor.md", "ithaca/stores/wine.md", "ithaca/household/the-twelve.md", "ithaca/loom/discovery.md", "ithaca/hall/plan.md", "ithaca/hall/weapons.md", "ithaca/household/medon.md", "ithaca/reported-and-remembered.md", "ithaca/_index.md", "people/mentor.md", "people/menelaus.md", "ithaca/island/orchard.md", "people/laertes.md"],
    fields: { open: 16 },
  },
  {
    path: "ithaca/homecoming-checklist.md",
    title: "Homecoming checklist",
    type: "checklist",
    created: "2025-11-02",
    updated: "2026-07-12",
    status: "not started",
    tags: ["landing", "checklist"],
    people: ["person:penelope", "person:telemachus", "person:laertes", "person:eumaeus", "person:argos"],
    places: ["place:ithaca", "place:scheria"],
    summary: "What to do in order once I am ashore on Ithaca. Not started: I am not ashore anywhere yet.",
    body: `Not started. The first item depends on things that have not happened: a raft that holds for seventeen days, a landfall at Scheria planned for 29 July ([[voyage/legs/ogygia-to-scheria]]), and a passage from there that nobody has offered. See [[goals/return-to-ithaca]].

## Before anyone sees me

- [ ] Land away from the town. [[ithaca/island/harbour-of-phorcys]]
- [ ] Put anything I carry somewhere nobody looks.
- [ ] Do not say my name. I have a record of what happens when I do: [[decisions/name-at-the-stern]].
- [ ] Walk inland to the yard. [[ithaca/island/eumaeus-yard]]

## First day

- [ ] Be a stranger at [[people/eumaeus]]'s door. Listen before speaking.
- [ ] Work through [[ithaca/questions-on-landing]] with him, in order.
- [ ] Find out if the boy is home. If not, wait for him there.

## When the boy is home

- [ ] Tell him first. Nobody else, not yet.
- [ ] [[people/philoetius]], in person: [[ithaca/island/philoetius-cattle]].

## The hall

- [ ] See it for myself before deciding anything. [[ithaca/hall/plan]]
- [ ] Read [[ithaca/suitors/families]] again before deciding anything.

## Penelope

- [ ] Let [[people/penelope]] test me. Do not hurry it. [[ithaca/island/the-bed]]

## My father

- [ ] Go to the farm. Bring the count of the trees. [[ithaca/island/orchard]]

## Argos

- [ ] Find him, if he is alive. [[ithaca/household/argos]]

Project: [[ithaca/estate]].`,
    links: ["goals/return-to-ithaca.md", "ithaca/island/harbour-of-phorcys.md", "decisions/name-at-the-stern.md", "ithaca/island/eumaeus-yard.md", "ithaca/questions-on-landing.md", "ithaca/island/philoetius-cattle.md", "ithaca/hall/plan.md", "ithaca/suitors/families.md", "ithaca/island/the-bed.md", "ithaca/island/orchard.md", "ithaca/household/argos.md", "ithaca/estate.md", "ithaca/_index.md", "voyage/legs/ogygia-to-scheria.md", "people/eumaeus.md", "people/philoetius.md", "people/penelope.md"],
    fields: { items: 14, started: false },
  },
];
