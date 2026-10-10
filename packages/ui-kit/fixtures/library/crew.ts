// Library domain: crew. See ../README.md and ./types.ts.
//
// The six hundred, ship by ship and loss by loss: roll calls, rotas, the
// parties sent ashore, the oath and the debts left to the living. Every count
// here closes against `crewLosses` in ../money.ts; nobody on these rolls is
// alive, so no record assigns them anything.

import type { LibraryDocument, ShipRecord } from "./types.js";

/** The twelve ships. Totals close against `crewLosses` in ../money.ts. */
export const shipRecords: ShipRecord[] = [
  { ship: 1, path: "crew/ships/ship-01.md", embarked: 50, lost: { Ismarus: 6, "Land of the Cyclopes": 6, Aeaea: 1, Scylla: 6, Thrinacia: 31 } },
  { ship: 2, path: "crew/ships/ship-02.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 3, path: "crew/ships/ship-03.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 4, path: "crew/ships/ship-04.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 5, path: "crew/ships/ship-05.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 6, path: "crew/ships/ship-06.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 7, path: "crew/ships/ship-07.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 8, path: "crew/ships/ship-08.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 9, path: "crew/ships/ship-09.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 10, path: "crew/ships/ship-10.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 11, path: "crew/ships/ship-11.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
  { ship: 12, path: "crew/ships/ship-12.md", embarked: 50, lost: { Ismarus: 6, "Land of the Laestrygonians": 44 } },
];

export const crewDocuments: LibraryDocument[] = [
  /* ------------------------------------------------------------ the ships */
  {
    path: "crew/ships/ship-01.md",
    title: "Ship 1",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "ithaca"],
    people: ["person:eurylochus", "person:elpenor"],
    places: ["place:troy", "place:cyclopes", "place:aeaea", "place:scylla", "place:thrinacia"],
    summary: "My own ship. Fifty out of Troy, the only hull to clear the Laestrygonian harbour, and broken by lightning off Thrinacia with thirty-one aboard.",
    body: `Fifty crew from Ithaca, myself not counted. The last of the twelve, and the one I was aboard for every loss.

## Roster over time

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 97-98 | the Cyclops's cave | 6 | 38 |
| 205 | moored outside the Laestrygonian harbour | 0 | 38 |
| 611 | Aeaea, the morning of leaving | 1 | 37 |
| 1043 | the strait, Scylla | 6 | 31 |
| 1084 | off Thrinacia, the storm | 31 | 0 |

## What is known

- Moored outside the harbour mouth on day 205, tied to a rock ([[decisions/moor-outside-the-harbour]]). I cut the cable with my own sword and we rowed ([[decisions/cut-the-cable]]). That is the only reason this column does not end at 205.
- [[crew/eurylochus]] was second in command from Aeaea onward. [[crew/elpenor]] was the youngest aboard.
- Named in this roll: [[crew/polites]], [[crew/perimedes]], [[crew/antiphus]]. The rest are recorded by bench and duty, because that is how I knew most of them at sea, and I will not make up what I did not write down.
- The helmsman was killed by the falling mast in the storm, before the hull broke: [[voyage/day-1084-the-storm]].

## Lost

Ismarus 6, Cyclopes 6, Aeaea 1, Scylla 6, Thrinacia 31. Fifty. See [[crew/losses/thrinacia]] and [[voyage/legs/the-wreck-and-charybdis]] for the end of it, and [[crew/_index]] for the fleet.`,
    links: ["crew/eurylochus.md", "crew/elpenor.md", "crew/polites.md", "crew/perimedes.md", "crew/antiphus.md", "crew/losses/thrinacia.md", "crew/_index.md", "decisions/moor-outside-the-harbour.md", "decisions/cut-the-cable.md", "voyage/day-1084-the-storm.md", "voyage/legs/the-wreck-and-charybdis.md"],
    fields: { ship: 1, embarked: 50, lost: 50, home: "Ithaca", fate: "wrecked off Thrinacia, day 1084" },
  },
  {
    path: "crew/ships/ship-02.md",
    title: "Ship 2",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "ithaca"],
    places: ["place:troy", "place:ismarus", "place:laestrygonians"],
    summary: "Fifty from Ithaca. Moored nearest the mouth inside the Laestrygonian harbour, close enough that her men were shouting to us when the stones began.",
    body: `Crewed from Ithaca. Fifty out of Troy.

## Roster over time

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

She lay nearest the harbour mouth, on the inside, a cable's length from where my own ship was tied outside. Her men ([[voyage/day-205-laestrygonian-harbour]]) saw the first stones fall before the ships deeper in did, and called across the water to us. I could hear them and could do nothing for them that would not have cost the thirty-eight with me.

Two of the three men sent up to the town that morning came from her benches; the third was the herald from ship 3. One of hers was taken in the king's hall ([[people/antiphates]]). The other ran back down, reached her deck, and died there with the rest.

## What the record still asks

- Whether anyone from her swam for the mouth. Nobody reached my ship. I watched for it.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/laestrygonians]], [[voyage/legs/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/losses/laestrygonians.md", "crew/_index.md", "voyage/day-205-laestrygonian-harbour.md", "people/antiphates.md", "voyage/legs/laestrygonians.md"],
    fields: { ship: 2, embarked: 50, lost: 50, home: "Ithaca", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-03.md",
    title: "Ship 3",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "ithaca"],
    places: ["place:troy", "place:ismarus", "place:laestrygonians"],
    summary: "Fifty from Ithaca. Carried the fleet's spare oars and the second sail; gave the herald for the party sent up to the Laestrygonian town.",
    body: `Crewed from Ithaca. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

She carried the fleet's spare oars, lashed along the gangway, and the second sail. When the spare gear went down with her, so did any chance of refitting a second hull, had there been one to refit.

Her herald went up to the town on day 205 ([[voyage/day-205-laestrygonian-harbour]]) with two men from ship 2. He was not the one taken in the hall, and he ran. He was back aboard her when the Laestrygonians came along the cliffs.

At Ismarus she lost six from her shore party, the same as every ship. Her six were among those still at the cooking fires at dawn ([[voyage/day-9-ismarus]]).

## Open

- [ ] Find out on Ithaca whose oars these were. The spare oars were cut from timber on Ithaca before the war; somebody's household will remember paying for them. For [[ithaca/questions-on-landing]].

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/laestrygonians]], [[crew/losses/ismarus]] and [[crew/_index]].`,
    links: ["crew/losses/laestrygonians.md", "crew/losses/ismarus.md", "crew/_index.md", "voyage/day-205-laestrygonian-harbour.md", "voyage/day-9-ismarus.md", "ithaca/questions-on-landing.md"],
    fields: { ship: 3, embarked: 50, lost: 50, home: "Ithaca", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-04.md",
    title: "Ship 4",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "ithaca"],
    places: ["place:troy", "place:ismarus", "place:laestrygonians"],
    summary: "Fifty from Ithaca. Her helmsman was wounded at Ismarus and kept the steering oar to the last day.",
    body: `Crewed from Ithaca. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

Her helmsman took a spear in the thigh on the beach at Ismarus ([[voyage/day-9-ismarus]]), during the fight that lasted until the sun went down. He would not give up the steering oar ([[knowledge/steering-oar]]), and he steered her through the storm off Cape Malea ([[voyage/legs/cape-malea]]) standing on one leg with his back against the stern post. I wrote that down at the time because I did not expect to see it twice.

She was moored in the middle of the line in the Laestrygonian harbour, with ships on either side ([[voyage/legs/laestrygonians]]). Nothing that happened in there was survivable by being in the middle.

> A ship is as good as the man at the oar at the back. Hers was the best in the fleet after mine, and I am not sure about mine.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/ismarus]], [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/losses/ismarus.md", "crew/losses/laestrygonians.md", "crew/_index.md", "voyage/day-9-ismarus.md", "knowledge/steering-oar.md", "voyage/legs/cape-malea.md", "voyage/legs/laestrygonians.md"],
    fields: { ship: 4, embarked: 50, lost: 50, home: "Ithaca", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-05.md",
    title: "Ship 5",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "ithaca"],
    places: ["place:troy", "place:ismarus", "place:aeolia", "place:laestrygonians"],
    summary: "Fifty from Ithaca, mostly from the farms under Mount Neriton. Last of the Ithaca ships in the line, and the one nearest mine when the bag was opened.",
    body: `Crewed from Ithaca, most of her benches from the farms under Mount Neriton ([[ithaca/island/neriton]]). Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

On day 171 ([[voyage/day-171-ithaca-in-sight]]) she was sailing close on my quarter. Her lookout called that he could see men tending fires on the shore of Ithaca. That was the last good report any of the twelve made, and it came from her bow. The bag ([[decisions/accept-the-bag-of-winds]]) was opened on my ship, not hers; her crew had no part in it and paid for it all the same.

Of the Ithaca ships she held the most men related to one another: three sets of brothers and a father with his son, as I noted the day we sailed. That makes her the hardest of the twelve to report on, because one house on the slopes of Neriton will hear it more than once.

## What the record still asks

- Which households under Neriton. I have the count of men, not the count of doors. See [[crew/families-owed-news]].

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/families-owed-news.md", "crew/losses/laestrygonians.md", "crew/_index.md", "ithaca/island/neriton.md", "voyage/day-171-ithaca-in-sight.md", "decisions/accept-the-bag-of-winds.md"],
    fields: { ship: 5, embarked: 50, lost: 50, home: "Ithaca", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-06.md",
    title: "Ship 6",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "same"],
    places: ["place:troy", "place:ismarus", "place:malea", "place:laestrygonians"],
    summary: "Fifty from Same. Lost her mast step in the storm off Cape Malea and was towed for a day; made it all the way to the harbour that ended her.",
    body: `Crewed from Same, across the channel from Ithaca. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 21 | off Cape Malea | 0 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

The storm off Cape Malea on day 21 ([[voyage/day-21-cape-malea]]) split her mast step. We lowered her mast ([[knowledge/mast-stepping]]), took her in tow from ship 7, and she rowed behind us for a day before the step was wedged and lashed. Nine days of being driven ([[voyage/legs/cape-malea]]), and she lost nobody. I recorded that as the fleet's best seamanship of the voyage and I have not changed my mind.

Her men were the quietest at Ismarus and still lost six. A count that is the same for every ship tells you nothing about the ship.

## What the record still asks

- Same has its own elders. Whether news from Ithaca reaches them, or whether it has to be carried across by someone who was there.
- Nobody who was there is left to carry it.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/laestrygonians]], [[crew/families-owed-news]] and [[crew/_index]].`,
    links: ["crew/losses/laestrygonians.md", "crew/families-owed-news.md", "crew/_index.md", "voyage/day-21-cape-malea.md", "knowledge/mast-stepping.md", "voyage/legs/cape-malea.md"],
    fields: { ship: 6, embarked: 50, lost: 50, home: "Same", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-07.md",
    title: "Ship 7",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "same"],
    places: ["place:troy", "place:ismarus", "place:malea", "place:laestrygonians"],
    summary: "Fifty from Same. Towed ship 6 through the worst day off Malea. Moored alongside her in the harbour, and went the same way.",
    body: `Crewed from Same. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 21 | off Cape Malea, towing ship 6 | 0 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

She took ship 6 in tow off Cape Malea on day 21 ([[voyage/legs/cape-malea]]) and held her for a day and a night in a sea that was taking oars out of men's hands. The two crews were from the same island and some from the same streets; nobody had to order it.

In the Laestrygonian harbour the two of them moored side by side, as they had been sailing since Malea. The stones came down on both at once ([[voyage/legs/laestrygonians]]).

## What I owe her

- A line in the account for Same that says she towed her sister through the storm. That is the thing her families should hear first, before the count.
- The count, after.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/ships/ship-06]], [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/ships/ship-06.md", "crew/losses/laestrygonians.md", "crew/_index.md", "voyage/legs/cape-malea.md", "voyage/legs/laestrygonians.md"],
    fields: { ship: 7, embarked: 50, lost: 50, home: "Same", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-08.md",
    title: "Ship 8",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "same"],
    places: ["place:troy", "place:ismarus", "place:lotus", "place:laestrygonians"],
    summary: "Fifty from Same. Stood the shore watch at the Lotus-eaters while the three men who ate the lotus were carried to ship 1, and lost nobody there.",
    body: `Crewed from Same. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 30 | Land of the Lotus-eaters | 0 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

On the beach of the Lotus-eaters, day 30 ([[voyage/day-30-lotus-eaters]]), her crew stood the shore watch while the three men who had eaten the lotus ([[knowledge/lotus]]) were carried back to my ship and tied under the benches ([[decisions/drag-back-the-lotus-eaters]]). She sent four men to help carry them; they did not eat anything offered, because I had told them not to and because they had seen the three.

Her rowing was steady rather than fast. She was usually third from the back of the line and never once lost sight of the ship ahead, which over two hundred days is more than I can say for some.

## What the record still asks

- Whether the four who carried the three back ever spoke of it. I did not ask at the time. See [[crew/lotus-eaters]].

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/lotus-eaters.md", "crew/losses/laestrygonians.md", "crew/_index.md", "voyage/day-30-lotus-eaters.md", "knowledge/lotus.md", "decisions/drag-back-the-lotus-eaters.md"],
    fields: { ship: 8, embarked: 50, lost: 50, home: "Same", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-09.md",
    title: "Ship 9",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "zacynthus"],
    places: ["place:troy", "place:ismarus", "place:laestrygonians"],
    summary: "Fifty from Zacynthus. The longest-serving crew of the twelve, nine of them at Troy from the first landing.",
    body: `Crewed from Zacynthus, the wooded island to the south. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

Nine of her fifty had been at Troy from the first landing on the beach, ten years before. Every other ship had replaced men along the way, from sickness and the fighting. She had replaced fewer than any, which I put down to the men who would not leave each other.

Her six at Ismarus ([[voyage/legs/ismarus]]) were all younger men, taken on in the last years of the war. The older hands had gone back to the ships when I gave the order ([[decisions/stay-the-night-at-ismarus]]). I noted this at the time without drawing anything from it; it still does not tell me anything I would want to say to their families.

## What the record still asks

- Zacynthus is a day's sail south of Ithaca. Whether any word has crossed in ten years, or whether they still keep a place on the shore for her.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/ismarus]], [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/losses/ismarus.md", "crew/losses/laestrygonians.md", "crew/_index.md", "voyage/legs/ismarus.md", "decisions/stay-the-night-at-ismarus.md"],
    fields: { ship: 9, embarked: 50, lost: 50, home: "Zacynthus", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-10.md",
    title: "Ship 10",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "zacynthus"],
    places: ["place:troy", "place:ismarus", "place:cyclopes", "place:laestrygonians"],
    summary: "Fifty from Zacynthus. Waited off the island of goats with the other ten while my ship went across to the Cyclopes, and waited well.",
    body: `Crewed from Zacynthus. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 96-99 | off the island of goats, waiting | 0 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

On day 96 ([[voyage/day-96-goat-island]]) the fleet beached on the small island off the coast of the Cyclopes, where the wild goats were. The other eleven stayed there while my ship crossed ([[decisions/enter-the-cave]]). Ship 10 had the shore watch for the three days I was in the cave, and kept the fires low so that nothing on the far coast would see them. When we came back short six ([[voyage/day-99-escape]]), her crew had a meal ready and asked no questions until we had eaten.

She held her place in the line all the way to the harbour. In the harbour she was moored on the far side, under the cliff where the stones came from.

## What the record still asks

- Nothing about her that I can answer. The questions are all for Zacynthus.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/cyclopes]], [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["crew/losses/cyclopes.md", "crew/losses/laestrygonians.md", "crew/_index.md", "voyage/day-96-goat-island.md", "decisions/enter-the-cave.md", "voyage/day-99-escape.md"],
    fields: { ship: 10, embarked: 50, lost: 50, home: "Zacynthus", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-11.md",
    title: "Ship 11",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "mainland"],
    places: ["place:troy", "place:ismarus", "place:laestrygonians"],
    summary: "Fifty from the mainland opposite Ithaca, where the herds graze. Carried the fleet's sacrificial animals out of Troy.",
    body: `Crewed from the mainland opposite Ithaca, the coast where the household's herds are kept. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

Her men were herdsmen before they were oarsmen, and she carried the animals the fleet had kept back for sacrifice. Every landing, she was first to the beach with an altar built from stones ([[knowledge/sacrifice-procedure]]). When I record that the fleet made its offerings on time, it was her crew that made them.

At Ismarus her shore party was the one driving cattle down to the beach when the Cicones came at dawn ([[voyage/day-9-ismarus]]). Six did not get back to the ships.

## What the record still asks

- Some of her families graze the household's herds on the mainland ([[ithaca/island/philoetius-cattle]]). They will hear the news from the same men who report the herds to the estate. See [[ithaca/estate]].
- Whether that is the right way for them to hear it. It is not.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/ismarus]], [[crew/losses/laestrygonians]] and [[crew/_index]].`,
    links: ["ithaca/estate.md", "crew/losses/ismarus.md", "crew/losses/laestrygonians.md", "crew/_index.md", "knowledge/sacrifice-procedure.md", "voyage/day-9-ismarus.md", "ithaca/island/philoetius-cattle.md"],
    fields: { ship: 11, embarked: 50, lost: 50, home: "the mainland opposite", fate: "destroyed in harbour, day 205" },
  },
  {
    path: "crew/ships/ship-12.md",
    title: "Ship 12",
    type: "ship",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "lost",
    tags: ["ship", "roster", "mainland"],
    places: ["place:troy", "place:ismarus", "place:laestrygonians"],
    summary: "Fifty from the mainland. First into the Laestrygonian harbour and moored deepest, which is where I would have put her too.",
    body: `Crewed from the mainland opposite Ithaca. Fifty out of Troy.

| Day | Where | Lost | Aboard |
|---|---|---|---|
| 3 | sailed from Troy | -- | 50 |
| 9 | Ismarus | 6 | 44 |
| 171 | Ithaca in sight | 0 | 44 |
| 205 | harbour of the Laestrygonians | 44 | 0 |

## What is known

The harbour had a narrow mouth and cliffs all round, and the water inside was flat ([[knowledge/laestrygonians]]). She went in first and furthest, and the others moored in after her, close together, as any captain would in water that calm ([[knowledge/mooring]]). I kept mine outside ([[decisions/moor-outside-the-harbour]]). I have gone over that choice more than any other on the voyage and the honest answer is that I did not trust the calm, not that I foresaw anything.

Being deepest in, she was furthest from the mouth. None of her men had a way out.

## What the record still asks

- Whether I should have ordered all twelve to stay outside. I did not order anything; the others chose the harbour and I chose the rock. The record does not show a decision because I did not make one.

Lost: Ismarus 6, Laestrygonians 44. See [[crew/losses/laestrygonians]], [[decisions/_index]] and [[crew/_index]].`,
    links: ["crew/losses/laestrygonians.md", "decisions/_index.md", "crew/_index.md", "knowledge/laestrygonians.md", "knowledge/mooring.md", "decisions/moor-outside-the-harbour.md"],
    fields: { ship: 12, embarked: 50, lost: 50, home: "the mainland opposite", fate: "destroyed in harbour, day 205" },
  },

  /* ----------------------------------------------------------- the losses */
  {
    path: "crew/losses/ismarus.md",
    title: "Loss: Ismarus",
    type: "loss",
    created: "2016-07-21",
    updated: "2026-07-08",
    status: "closed",
    tags: ["loss", "ismarus", "wine"],
    places: ["place:ismarus"],
    summary: "Seventy-two, six from every ship. They would not leave the wine, and the Cicones came down at dawn with their neighbours from inland.",
    body: `**Count:** 72, six from each of the twelve ships. **Day:** 9. **Cause:** would not leave the wine.

## What happened

We sacked the town of the Cicones ([[decisions/raid-ismarus]]) on the coast and divided what we took so that no man went without his share. I gave the order to sail at once ([[decisions/stay-the-night-at-ismarus]]). The men did not want to: there was wine, and sheep and cattle on the beach, and they had been at war for ten years. They drank and slaughtered by the ships through the night.

The Cicones in the town had called their neighbours from inland, who fought from chariots and on foot. They came at dawn, as many as leaves. We fought by the ships until the sun went down and then we broke. Six men from every ship were left on that beach.

## Ships affected

All twelve, six each. See [[crew/ships/ship-01]] through [[crew/ships/ship-12]].

## Before sailing

We did not leave until each of the seventy-two had been called by name three times from the ships ([[voyage/day-10-ismarus-morning-after]]). That is recorded in [[crew/burials-and-cenotaphs]].

## What the record still asks

- [ ] Whether I gave the order to leave clearly enough. I gave it once. I did not give it again.
- [ ] [[people/maron]], the priest of Apollo, and his household were spared. The wine he gave is in [[crew/ismarus-wine-ration]]. Whether sparing one house is anything to set against seventy-two.

Ledger: [[crew/_index]].`,
    links: ["crew/ships/ship-01.md", "crew/ships/ship-12.md", "crew/burials-and-cenotaphs.md", "crew/ismarus-wine-ration.md", "crew/_index.md", "decisions/raid-ismarus.md", "decisions/stay-the-night-at-ismarus.md", "voyage/day-10-ismarus-morning-after.md", "people/maron.md"],
    fields: { day: 9, place: "Ismarus", lost: 72, ships: 12, cause: "would not leave the wine" },
  },
  {
    path: "crew/losses/cyclopes.md",
    title: "Loss: the Cyclops's cave",
    type: "loss",
    created: "2016-10-16",
    updated: "2026-07-08",
    status: "closed",
    tags: ["loss", "cyclopes", "cave"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes"],
    summary: "Six from my own ship, eaten two at a time over two days in a cave I chose to wait in.",
    body: `**Count:** 6, all from ship 1. **Landed:** day 96. **Taken:** two the first evening, two the next morning, two that evening. **Escape:** day 99. **Cause:** eaten.

## What happened

I took twelve men across to the cave of [[people/polyphemus]] to see who lived there, against the advice of the men who wanted to take the cheeses and lambs and go. I wanted to see him and to see whether he would offer a guest-gift. He offered neither. He shut the door with a stone no twelve of us could move ([[knowledge/cyclops-door-stone]]), and he ate.

We could not kill him in his sleep, because nobody but he could move the stone. So we waited ([[decisions/wait-for-polyphemus]]), and blinded him with the olive stake on the second night ([[decisions/blind-rather-than-kill]]), and went out under his rams in the morning. Twelve went in with me; six came out. [[crew/antiphus]] was the last he ate.

## Ships affected

Ship 1 only, 44 to 38. The other eleven were waiting off the island of goats. See [[crew/ships/ship-01]] and [[crew/cave-party]].

## What the record still asks

- [ ] Whether the six are on my count or on his. They are on mine. I stayed to see him.
- [ ] The name I shouted from the stern afterwards, which is a separate record and a separate cost: [[decisions/name-at-the-stern]].
- [ ] Antiphus's father on Ithaca, [[people/aegyptius]], has not been told.

Ledger: [[crew/_index]].`,
    links: ["people/polyphemus.md", "crew/antiphus.md", "crew/ships/ship-01.md", "crew/cave-party.md", "decisions/name-at-the-stern.md", "crew/_index.md", "knowledge/cyclops-door-stone.md", "decisions/wait-for-polyphemus.md", "decisions/blind-rather-than-kill.md", "people/aegyptius.md"],
    fields: { day: 96, place: "Land of the Cyclopes", lost: 6, ships: 1, cause: "eaten" },
  },
  {
    path: "crew/losses/laestrygonians.md",
    title: "Loss: the Laestrygonian harbour",
    type: "loss",
    created: "2017-02-02",
    updated: "2026-07-08",
    status: "closed",
    tags: ["loss", "laestrygonians", "harbour"],
    places: ["place:laestrygonians"],
    summary: "Four hundred and eighty-four. Eleven ships in a closed harbour, stones from the cliffs, and men speared like fish. One ship outside.",
    body: `**Count:** 484, forty-four from each of ships 2 to 12. **Day:** 205. **Cause:** eleven ships, in harbour.

## What happened

The harbour had a narrow entrance between two headlands and cliffs all round. The eleven went in and moored close together. I tied my ship to a rock outside the mouth ([[decisions/moor-outside-the-harbour]]). Three men went up to the town; one of them was seized in the king's hall ([[people/antiphates]]) and eaten, and the other two ran. The man taken was from ship 2 and is counted in her forty-four, inside the 484.

The Laestrygonians ([[knowledge/laestrygonians]]) came along the cliff tops in thousands, the size of giants, and threw rocks down onto the ships, each rock as much as a man could lift. The noise of the ships breaking and the men dying went on. They speared the men in the water like fish and carried them off to eat.

I cut my cable with my sword ([[decisions/cut-the-cable]]) and told my crew to row if they wanted to live. They rowed.

## Ships affected

| Ship | Aboard that morning | Lost |
|---|---|---|
| 1 | 38 | 0 |
| 2-12 | 44 each | 44 each |

See [[crew/ships/ship-02]] and [[crew/ships/ship-12]] for the first and the deepest.

## What the record still asks

- [ ] Whether there was a moment to call the eleven out. There was not; the stones started with the shouting.
- [ ] Four hundred and eighty-four families, and I am the only person who can tell them where.

Ledger: [[crew/_index]].`,
    links: ["crew/ships/ship-02.md", "crew/ships/ship-12.md", "crew/_index.md", "decisions/moor-outside-the-harbour.md", "people/antiphates.md", "knowledge/laestrygonians.md", "decisions/cut-the-cable.md"],
    fields: { day: 205, place: "Land of the Laestrygonians", lost: 484, ships: 11, cause: "eleven ships, in harbour" },
  },
  {
    path: "crew/losses/aeaea.md",
    title: "Loss: Aeaea",
    type: "loss",
    created: "2018-03-24",
    updated: "2026-07-08",
    status: "closed",
    tags: ["loss", "aeaea", "elpenor"],
    people: ["person:elpenor", "person:circe"],
    places: ["place:aeaea", "place:acheron"],
    summary: "One. Elpenor fell from Circe's roof the morning we sailed, and nobody counted him missing until he met us among the dead.",
    body: `**Count:** 1, ship 1. **Died:** day 611. **Recorded:** day 620. **Buried:** day 624. **Cause:** fell from a roof.

## What happened

[[crew/elpenor]] had been drinking and went up onto the roof of [[people/circe]]'s house to sleep where it was cool. In the morning he heard the noise of the men getting ready, got up still half asleep, forgot the ladder, and fell from the roof. His neck broke ([[voyage/day-611-elpenor]]).

Nobody saw. We sailed short one man and I did not know it. There was no count that morning; that is the failure in this record, and it is mine.

He was the first of the dead to come to us at the pit on day 620 ([[voyage/day-620-acheron]]), before Teiresias, and asked ([[oaths/promise-to-elpenor]]) to be burned with his armour and buried under a barrow on the shore with his oar planted on top. We went back to Aeaea and did it on day 624: [[crew/barrow-on-aeaea]].

## Ships affected

Ship 1, 38 to 37.

## What the record still asks

- [x] Burial with his oar. Done day 624: [[voyage/day-624-elpenor-buried]].
- [ ] Why there was no roll call on day 611. See [[crew/roll-calls/day-620]] and [[crew/standing-orders]].

Ledger: [[crew/_index]].`,
    links: ["crew/elpenor.md", "people/circe.md", "crew/barrow-on-aeaea.md", "crew/roll-calls/day-620.md", "crew/standing-orders.md", "crew/_index.md", "voyage/day-611-elpenor.md", "voyage/day-620-acheron.md", "oaths/promise-to-elpenor.md", "voyage/day-624-elpenor-buried.md"],
    fields: { day: 611, place: "Aeaea", lost: 1, ships: 1, cause: "fell from a roof" },
  },
  {
    path: "crew/losses/scylla.md",
    title: "Loss: Scylla",
    type: "loss",
    created: "2019-05-21",
    updated: "2026-07-08",
    status: "closed",
    tags: ["loss", "scylla", "strait"],
    places: ["place:scylla", "place:charybdis", "place:messina"],
    summary: "Six, taken from the deck in one pass. I knew the count before we entered the strait and did not tell them.",
    body: `**Count:** 6, ship 1. **Day:** 1043. **Cause:** taken from the deck.

## What happened

[[people/circe]] told me there was no fighting Scylla and no passing her without paying: six heads, six men. The other side was Charybdis, which takes the whole ship. I chose Scylla and held the ship close under her cliff. The reasoning is in [[decisions/scylla-or-charybdis]]; the hazard in [[knowledge/scylla]].

I did not tell the crew ([[decisions/what-to-tell-the-crew]]). I told them about Charybdis and told them to row. I put on my armour and stood in the bow with two spears, which Circe had told me was useless, and it was ([[decisions/arm-against-scylla]]). While we were all looking at Charybdis, the six heads came down and took six men off the benches. They called my name as they went up.

## Ships affected

Ship 1, 37 to 31.

## The six

Listed by bench and duty in [[crew/scylla-six]].

## What the record still asks

- [ ] Whether they should have been told. The decision record says six against six hundred, which is how it looked from the bow. From the benches it would have looked different, and I took that away from them.
- [ ] Whether the bow was the right place for me to stand. It was the place I could see the most from and do the least.

Ledger: [[crew/_index]]. Day log: [[voyage/day-1043-strait]]. Leg: [[voyage/legs/the-strait]].`,
    links: ["decisions/scylla-or-charybdis.md", "knowledge/scylla.md", "crew/scylla-six.md", "crew/_index.md", "voyage/day-1043-strait.md", "people/circe.md", "decisions/what-to-tell-the-crew.md", "decisions/arm-against-scylla.md", "voyage/legs/the-strait.md"],
    fields: { day: 1043, place: "Scylla", lost: 6, ships: 1, cause: "taken from the deck" },
  },
  {
    path: "crew/losses/thrinacia.md",
    title: "Loss: Thrinacia",
    type: "loss",
    created: "2019-07-01",
    updated: "2026-07-08",
    status: "closed",
    tags: ["loss", "thrinacia", "oath"],
    people: ["person:eurylochus", "person:teiresias"],
    places: ["place:thrinacia", "place:charybdis"],
    summary: "Thirty-one, everyone left. The oath, a month of wrong wind, the cattle killed while I slept, and the storm a day out.",
    body: `**Count:** 31, ship 1, every remaining man. **Day:** 1084. **Cause:** the oath, then the storm.

## What happened

We landed on Thrinacia on day 1044 against my judgement ([[decisions/land-on-thrinacia]]) and on [[crew/eurylochus]]'s argument that the men could not row another night. Every man swore not to touch the herds of the sun: [[oaths/helios]]. Then the wind held from the south and east for a month. The stores ran out. The men fished and trapped birds.

On day 1077 I went inland to pray and fell asleep ([[voyage/day-1077-the-cattle]]). Eurylochus persuaded the others, and they drove off the best of the cattle and killed them. They feasted for six days. On day 1084 the wind changed and we sailed. A day out, the sky closed over us and Zeus struck the ship with lightning ([[omens/day-1084-thunder]]). The mast came down on the helmsman. The hull broke. Every man was thrown into the sea, and none came up near me.

## Ships affected

Ship 1, 31 to 0. The last ship. See [[crew/ships/ship-01]].

## What the record still asks

- [ ] The forecast had one condition: [[knowledge/teiresias-forecast]]. It was told to me, and I told them. Whether telling was enough.
- [ ] The two times on this voyage I slept when it mattered, the crew acted. See [[crew/watch-rota]].

The decision: [[decisions/cattle-of-helios]]. Leg: [[voyage/legs/thrinacia]]. Ledger: [[crew/_index]].`,
    links: ["crew/eurylochus.md", "oaths/helios.md", "crew/ships/ship-01.md", "knowledge/teiresias-forecast.md", "crew/watch-rota.md", "decisions/cattle-of-helios.md", "crew/_index.md", "decisions/land-on-thrinacia.md", "voyage/day-1077-the-cattle.md", "omens/day-1084-thunder.md", "voyage/legs/thrinacia.md"],
    fields: { day: 1084, place: "Thrinacia", lost: 31, ships: 1, cause: "the oath, then the storm" },
  },

  /* ------------------------------------------------- crew Homer names */
  {
    path: "crew/polites.md",
    title: "Polites",
    type: "person",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "dead",
    tags: ["crew", "ship-1", "aeaea"],
    places: ["place:aeaea", "place:thrinacia"],
    summary: "Ship 1. The dearest of my companions and the one I trusted most. First to hear the singing in Circe's house, and the one who said to call out.",
    body: `**Ship:** 1, from Ithaca. **Standing:** dead, lost off Thrinacia, day 1084.

Polites was the man I would have put in command of the ship if I had gone over the side. I did not write that down while he was alive because it would have been unfair to [[crew/eurylochus]], who had the rank. I am writing it now.

## Aeaea

He was one of the twenty-two who went with Eurylochus on the first day on Aeaea ([[crew/aeaea-scouting-party]]). When they came to the house in the forest clearing and heard a woman singing at a loom inside ([[voyage/day-247-the-swine]]), it was Polites who said there was someone there, goddess or woman, and they should call to her. They called. She opened the doors. Everyone but Eurylochus went in.

He came back to me as a man again, after [[people/hermes]] and the herb ([[knowledge/moly]]). I do not hold the calling against him. Anyone would have called.

## After

He was with me at the house of the dead, through the Sirens and the strait. Scylla did not take him. He swore the oath on Thrinacia ([[oaths/helios]]) and I do not know which way he spoke when Eurylochus made his argument over the cattle, because I was asleep. I have chosen not to guess.

## Owed

- His household on Ithaca: an account of Aeaea that says he was the one who spoke first, and that it was a reasonable thing to do.

See [[crew/_index]].`,
    links: ["crew/eurylochus.md", "crew/aeaea-scouting-party.md", "crew/_index.md", "voyage/day-247-the-swine.md", "people/hermes.md", "knowledge/moly.md", "oaths/helios.md"],
    fields: { ship: 1, home: "Ithaca", died: 1084, place: "Thrinacia", source: "Book X" },
  },
  {
    path: "crew/perimedes.md",
    title: "Perimedes",
    type: "person",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "dead",
    tags: ["crew", "ship-1", "acheron"],
    people: ["person:eurylochus"],
    places: ["place:acheron", "place:sirens", "place:thrinacia"],
    summary: "Ship 1. Held the victims at the pit with Eurylochus, and tightened the ropes on me at the Sirens when I asked for them to be loosened.",
    body: `**Ship:** 1, from Ithaca. **Standing:** dead, lost off Thrinacia, day 1084.

## At the house of the dead

On day 620 ([[voyage/day-620-acheron]]), Perimedes and [[crew/eurylochus]] held the ram and the ewe while I dug the pit a forearm's length each way and poured the offerings ([[knowledge/rites-for-the-dead]]). They did not look into the pit when the dead came up. I asked them not to and they did not. That is harder than it sounds, and I noted it.

## At the Sirens

On day 1041 I had the crew bind me to the mast and told them that if I begged to be let go, they were to tie me tighter. I begged. Perimedes and Eurylochus got up from their benches and put more rope on me, which is exactly what I had told them to do ([[oaths/sirens-binding-order]]), and they did not hesitate. See [[knowledge/sirens]] and [[voyage/legs/sirens]].

## On the record

| | |
|---|---|
| Bench | stern bench |
| Duties | sacrifice, ropes, the stern watch |
| Oath on Thrinacia | sworn |
| Lost | day 1084, in the storm |

He did what he was told when what he was told was hard. I would like his family to know that this was a thing I counted on.

See [[crew/oath-signatories]] and [[crew/_index]].`,
    links: ["crew/eurylochus.md", "knowledge/sirens.md", "crew/oath-signatories.md", "crew/_index.md", "voyage/day-620-acheron.md", "knowledge/rites-for-the-dead.md", "oaths/sirens-binding-order.md", "voyage/legs/sirens.md"],
    fields: { ship: 1, home: "Ithaca", died: 1084, place: "Thrinacia", source: "Books XI and XII" },
  },
  {
    path: "crew/antiphus.md",
    title: "Antiphus",
    type: "person",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "dead",
    tags: ["crew", "ship-1", "cyclopes"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes", "place:ithaca"],
    summary: "Ship 1, a spearman, son of Aegyptius of Ithaca. The last of the six the Cyclops ate.",
    body: `**Ship:** 1, from Ithaca. **Standing:** dead, in the cave of [[people/polyphemus]], day 98.

Antiphus was a spearman, and a good one, and he went into the cave with me because I picked him. Of the twelve who went in, six came out. He was the last of the six who did not: taken on the second evening, after he had watched the four before him ([[voyage/day-98-the-stake]]).

## His family

His father is [[people/aegyptius]], an elder on Ithaca who has sat in the assembly since before I was born. He had other sons who stayed at home. I do not know what Aegyptius has heard. Ten years is long enough for any father to have decided something about a son who did not come back, and I do not know which thing he has decided.

## What I owe

- [ ] Tell Aegyptius in person. Not through a herald and not through the household.
- [ ] Tell him the order of it if he asks, and only if he asks. He was the last.
- [ ] Tell him it was my choice to stay in the cave and wait for the owner ([[decisions/wait-for-polyphemus]]). Not the gods'.

## On the record

| | |
|---|---|
| Party | the cave party of twelve |
| Lost | day 98, evening |
| Body | none |

See [[crew/cave-party]], [[crew/losses/cyclopes]] and [[crew/_index]].`,
    links: ["people/polyphemus.md", "crew/cave-party.md", "crew/losses/cyclopes.md", "crew/_index.md", "voyage/day-98-the-stake.md", "people/aegyptius.md", "decisions/wait-for-polyphemus.md"],
    fields: { ship: 1, home: "Ithaca", died: 98, place: "Land of the Cyclopes", source: "Book II" },
  },

  /* ------------------------------------------------------------ roll calls */
  {
    path: "crew/roll-calls/day-3.md",
    title: "Roll call, day 3: sailing from Troy",
    type: "roll-call",
    created: "2016-07-15",
    updated: "2016-07-15",
    status: "closed",
    tags: ["roll-call", "troy", "fleet"],
    places: ["place:troy"],
    summary: "Twelve ships, fifty to a ship, six hundred men. Every bench filled and every name answered on the beach before we pushed off.",
    body: `Taken on the beach below Troy at first light ([[voyage/legs/troy-departure]]), ship by ship, each crew standing by its own hull. Every name answered.

| Ship | Home | Aboard |
|---|---|---|
| 1 | Ithaca | 50 |
| 2 | Ithaca | 50 |
| 3 | Ithaca | 50 |
| 4 | Ithaca | 50 |
| 5 | Ithaca | 50 |
| 6 | Same | 50 |
| 7 | Same | 50 |
| 8 | Same | 50 |
| 9 | Zacynthus | 50 |
| 10 | Zacynthus | 50 |
| 11 | the mainland opposite | 50 |
| 12 | the mainland opposite | 50 |
| | **Total** | **600** |

## Notes

- I am not on the roll. The count is the men I am bringing home, not the men who are going.
- Spare oars and the second sail on ship 3. Sacrificial animals on ship 11.
- Shares of the Troy plunder stowed by ship and by man: [[crew/shares-owed]].
- Standing orders read out to every crew: [[crew/standing-orders]].

Expected passage: one sailing season ([[voyage/day-3-departure]]). See [[crew/_index]].`,
    links: ["crew/shares-owed.md", "crew/standing-orders.md", "crew/_index.md", "voyage/legs/troy-departure.md", "voyage/day-3-departure.md"],
    fields: { day: 3, aboard: 600, ships: 12, place: "Troy" },
  },
  {
    path: "crew/roll-calls/day-10.md",
    title: "Roll call, day 10: after Ismarus",
    type: "roll-call",
    created: "2016-07-22",
    updated: "2016-07-22",
    status: "closed",
    tags: ["roll-call", "ismarus", "fleet"],
    places: ["place:ismarus"],
    summary: "Five hundred and twenty-eight. Six short on every ship, and every one of the seventy-two called three times before the oars went in.",
    body: `Taken at sea, the morning after we broke from the beach at Ismarus ([[voyage/legs/ismarus]]). Each ship called its own and signalled the count across.

| Ship | Day 3 | Lost at Ismarus | Aboard |
|---|---|---|---|
| 1 | 50 | 6 | 44 |
| 2-12 | 50 each | 6 each | 44 each |
| **Fleet** | **600** | **72** | **528** |

## Notes

No ship lost more than six and no ship lost fewer. I have looked at that more than once. It is what happens when twelve crews fight in one line on one beach and fall back in one line to their own hulls.

Before we rowed out of range the night before, every ship called the names of its six three times ([[voyage/day-10-ismarus-morning-after]]). Nobody had to be told to.

The wounded are on their own benches and rowing. Ship 4's helmsman is steering on one leg.

## For the record

- [ ] Wine aboard: rationed from today. See [[crew/ismarus-wine-ration]].
- [ ] Shares from Ismarus: the seventy-two shares are held by their ships. See [[crew/shares-owed]].

Journal: [[journal/day-10]]. Losses: [[crew/losses/ismarus]]. Ledger: [[crew/_index]].`,
    links: ["crew/ismarus-wine-ration.md", "crew/shares-owed.md", "crew/losses/ismarus.md", "crew/_index.md", "voyage/legs/ismarus.md", "voyage/day-10-ismarus-morning-after.md", "journal/day-10.md"],
    fields: { day: 10, aboard: 528, ships: 12, place: "at sea, off Ismarus" },
  },
  {
    path: "crew/roll-calls/day-31.md",
    title: "Roll call, day 31: leaving the Lotus-eaters",
    type: "roll-call",
    created: "2016-08-12",
    updated: "2016-08-12",
    status: "closed",
    tags: ["roll-call", "lotus", "fleet"],
    places: ["place:lotus"],
    summary: "Five hundred and twenty-eight, all present. Three of them were present tied under the benches.",
    body: `Taken on the beach before embarking and again at sea ([[voyage/day-31-leaving-the-lotus]]). Unchanged since day 10.

| Ship | Aboard | Note |
|---|---|---|
| 1 | 44 | three men under the benches, tied |
| 2-12 | 44 each | |
| **Fleet** | **528** | |

## Notes

The three who went inland and ate the lotus are counted present. They are not well. They answered their names when called, but they answered as if they were somewhere else and the names did not concern them much. I am recording them as present and fit to row in a few days, which is a hope rather than an assessment.

Nine days of storm from Cape Malea ([[voyage/legs/cape-malea]]) and nobody lost to it. Ship 6's mast step held after the repair.

The order today was: nobody eats anything given to them on this shore, nobody goes inland, everybody to the benches. It was obeyed.

## Open

- [ ] Watch the three for a week. If any of them tries to go back over the side, two men on him and nobody argues.
- [ ] Find out whether the lotus wears off ([[knowledge/lotus]]). Nobody on that beach could tell me, because nobody on that beach wanted it to.

The three: [[crew/lotus-eaters]]. Ledger: [[crew/_index]].`,
    links: ["crew/lotus-eaters.md", "crew/_index.md", "voyage/day-31-leaving-the-lotus.md", "voyage/legs/cape-malea.md", "knowledge/lotus.md"],
    fields: { day: 31, aboard: 528, ships: 12, place: "Land of the Lotus-eaters" },
  },
  {
    path: "crew/roll-calls/day-99.md",
    title: "Roll call, day 99: back from the cave",
    type: "roll-call",
    created: "2016-10-19",
    updated: "2016-10-19",
    status: "closed",
    tags: ["roll-call", "cyclopes", "fleet"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Five hundred and twenty-two. Six short on my own ship. Taken on the island of goats with the rams we drove out, and with the name already shouted.",
    body: `Taken on the island of goats when ship 1 came back across with the Cyclops's flock aboard ([[voyage/day-99-escape]]).

| Ship | Day 10 | Lost | Aboard |
|---|---|---|---|
| 1 | 44 | 6 | 38 |
| 2-12 | 44 each | 0 | 44 each |
| **Fleet** | **528** | **6** | **522** |

## Notes

The other eleven crews were on the beach with the fires low. They counted us in as we came, and they could see we were short before the hull touched sand.

The flock was shared out so that no man went without. The ram I came out under was given to me, and I burned its thighs on the shore. The offering was not accepted ([[omens/day-99-ram-refused]]). I knew that the way you know a wind is wrong.

The six from the cave are written into [[crew/losses/cyclopes]]. I have taken them off ship 1's oar rota: [[crew/oar-bench-rota]].

## Open

- [ ] The name I shouted as we cleared the beach. It is filed separately: [[decisions/name-at-the-stern]], and its cost in [[oaths/polyphemus-curse]].
- [ ] Bench reassignment on ship 1 for thirty-eight. Done tonight.

Ledger: [[crew/_index]].`,
    links: ["crew/losses/cyclopes.md", "crew/oar-bench-rota.md", "decisions/name-at-the-stern.md", "crew/_index.md", "voyage/day-99-escape.md", "omens/day-99-ram-refused.md", "oaths/polyphemus-curse.md"],
    fields: { day: 99, aboard: 522, ships: 12, place: "the island of goats" },
  },
  {
    path: "crew/roll-calls/day-172.md",
    title: "Roll call, day 172: blown back to Aeolia",
    type: "roll-call",
    created: "2016-12-31",
    updated: "2016-12-31",
    status: "closed",
    tags: ["roll-call", "aeolia", "fleet"],
    places: ["place:aeolia", "place:ithaca"],
    summary: "Five hundred and twenty-two, every one of them alive, and every one of them back on the island we had sailed from.",
    body: `Taken on the beach of Aeolus's island, after nine days' sailing, one sight of home, and a storm that blew us back the whole way.

| Ship | Aboard |
|---|---|
| 1 | 38 |
| 2-12 | 44 each |
| **Fleet** | **522** |

## Notes

Nobody was lost. I write that because the count says it and because it is the only thing on this page that is good.

On day 171 ([[voyage/day-171-ithaca-in-sight]]) we were close enough to Ithaca to see the men tending fires on the shore. I had held the sheet myself for nine days and nights and I slept ([[decisions/keep-the-helm-nine-days]]). The crew on my ship opened the bag Aeolus had given me, because they thought it held gold and silver I was keeping from them. The winds came out of it together.

Aeolus would not see us twice ([[voyage/day-172-aeolus-refuses]]). He told me to leave his island, that a man the gods hated so much was not a man he could help. We left.

## For the record

- [ ] Who opened the bag. I have not asked, and I will not. It was my ship, and I had not told them what was in it. See [[crew/aeolia-bag]].
- [ ] Rowing from here. No wind is coming to us now that we did not row for.

Ledger: [[crew/_index]].`,
    links: ["crew/aeolia-bag.md", "crew/_index.md", "voyage/day-171-ithaca-in-sight.md", "decisions/keep-the-helm-nine-days.md", "voyage/day-172-aeolus-refuses.md"],
    fields: { day: 172, aboard: 522, ships: 12, place: "Aeolia" },
  },
  {
    path: "crew/roll-calls/day-206.md",
    title: "Roll call, day 206: one ship",
    type: "roll-call",
    created: "2017-02-03",
    updated: "2017-02-03",
    status: "closed",
    tags: ["roll-call", "laestrygonians", "ship-1"],
    places: ["place:laestrygonians"],
    summary: "Thirty-eight. The fleet is one hull. Eleven ships are not on this roll because there is nobody left in them to answer.",
    body: `Taken at sea, the morning after the harbour ([[voyage/day-205-laestrygonian-harbour]]). There was no beach to take it on.

| Ship | Day 172 | Lost | Aboard |
|---|---|---|---|
| 1 | 38 | 0 | 38 |
| 2-12 | 44 each | 44 each | 0 |
| **Fleet** | **522** | **484** | **38** |

## Notes

I called it the old way, ship by ship, from 1 to 12, because I did not know another way to do it. For ships 2 to 12 I called the ship's number and then waited for as long as it would take a crew to answer. Nobody on my benches spoke during it. Then I called our own thirty-eight by name and every one answered.

From today the fleet roll and ship 1's roll are the same thing. I am keeping both headings in the record anyway. The other eleven are owed their column even when the column is a zero.

## Changes

- Ship 1 rota unchanged, thirty-eight to the benches: [[crew/oar-bench-rota]].
- Watch rota now drawn from one crew: [[crew/watch-rota]].
- Every share held in ships 2 to 12 is lost with them: [[crew/shares-owed]].

Log: [[voyage/day-206-one-ship]]. Journal: [[journal/day-206]]. Losses: [[crew/losses/laestrygonians]]. Ledger: [[crew/_index]].`,
    links: ["crew/oar-bench-rota.md", "crew/watch-rota.md", "crew/shares-owed.md", "crew/losses/laestrygonians.md", "crew/_index.md", "voyage/day-205-laestrygonian-harbour.md", "voyage/day-206-one-ship.md", "journal/day-206.md"],
    fields: { day: 206, aboard: 38, ships: 1, place: "at sea" },
  },
  {
    path: "crew/roll-calls/day-620.md",
    title: "Roll call, day 620: corrected at the pit",
    type: "roll-call",
    created: "2018-03-24",
    updated: "2018-03-28",
    status: "closed",
    tags: ["roll-call", "acheron", "correction"],
    people: ["person:elpenor", "person:teiresias"],
    places: ["place:acheron", "place:aeaea"],
    summary: "Thirty-seven. Corrected by the first of the dead to come up. There was no roll call on the morning we left Aeaea, and there should have been.",
    body: `Taken at the edge of the river where we beached for the house of the dead ([[voyage/legs/house-of-the-dead]]). This roll was corrected after it was taken, which is the reason it exists as its own record.

| | Count |
|---|---|
| Last count, Aeaea, before the final night | 38 |
| Roll taken on the beach, day 620 | 37 answered |
| Recorded before this as | 38 |
| **Corrected** | **37** |

## What happened

I took the roll before going up to the pit and one name did not answer. I assumed I had miscounted and did not take it again. Then [[crew/elpenor]] was the first of the dead to come up, before the seer, and told me how he had fallen from Circe's roof the morning we sailed.

There was no roll call on day 611 ([[voyage/day-611-elpenor]]). We were leaving a house where we had been guests for a year, the men were getting ready in the dark, and I let the morning go without one. Nobody else missed him either; nobody else was asked to.

## Correction

- Ship 1, 38 to 37, effective day 611.
- Loss record: [[crew/losses/aeaea]].
- Standing order added: no embarkation without a roll call. [[crew/standing-orders]].
- Burial promised ([[oaths/promise-to-elpenor]]) and carried out on day 624 ([[voyage/day-624-elpenor-buried]]).

Ledger: [[crew/_index]].`,
    links: ["crew/elpenor.md", "crew/losses/aeaea.md", "crew/standing-orders.md", "crew/_index.md", "voyage/legs/house-of-the-dead.md", "voyage/day-611-elpenor.md", "oaths/promise-to-elpenor.md", "voyage/day-624-elpenor-buried.md"],
    fields: { day: 620, aboard: 37, ships: 1, place: "the house of the dead" },
  },
  {
    path: "crew/roll-calls/day-1043.md",
    title: "Roll call, day 1,043: through the strait",
    type: "roll-call",
    created: "2019-05-21",
    updated: "2019-05-21",
    status: "closed",
    tags: ["roll-call", "scylla", "ship-1"],
    places: ["place:scylla", "place:messina"],
    summary: "Thirty-one. Taken at the oars while we were still rowing, because nobody would stop.",
    body: `Taken on the benches, in the open water beyond the strait ([[voyage/legs/the-strait]]). I did not ask them to ship oars for it. They would not have.

| | Count |
|---|---|
| Aboard at the Sirens, day 1041 | 37 |
| Taken from the deck by Scylla | 6 |
| **Aboard** | **31** |

## Notes

I called the roll from the stern. Six names did not answer. The men knew which six before I reached them, and the benches on the landward side were already shifted to cover the gaps by the time I had finished.

The six are recorded by bench in [[crew/scylla-six]]. They called my name as they were lifted, and I wrote that down at once so that it would be in the record exactly and not as I would remember it later.

## Open

- [ ] Nobody has asked me whether I knew. They will. [[decisions/what-to-tell-the-crew]].
- [ ] Re-seat thirty-one on the benches for the long pull. [[crew/oar-bench-rota]].
- [ ] Thrinacia is in sight. Circe and Teiresias both told me to pass it by. [[decisions/land-on-thrinacia]].

Losses: [[crew/losses/scylla]]. Ledger: [[crew/_index]].`,
    links: ["crew/scylla-six.md", "crew/oar-bench-rota.md", "crew/losses/scylla.md", "crew/_index.md", "voyage/legs/the-strait.md", "decisions/what-to-tell-the-crew.md", "decisions/land-on-thrinacia.md"],
    fields: { day: 1043, aboard: 31, ships: 1, place: "beyond the strait" },
  },
  {
    path: "crew/roll-calls/day-1084.md",
    title: "Roll call, day 1,084: the last one",
    type: "roll-call",
    created: "2019-07-01",
    updated: "2019-07-12",
    status: "closed",
    tags: ["roll-call", "thrinacia", "ship-1"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Thirty-one answered on the beach of Thrinacia before we sailed. It is the last roll call of the voyage. The next count is one.",
    body: `Taken on the beach at Thrinacia at first light, when the wind finally came round after a month.

| | Count |
|---|---|
| Called | 31 |
| Answered | 31 |
| Aboard at sailing | 31 |

Every man answered. [[crew/eurylochus]] answered first, as second in command, and looked at me while he did it. I did not say anything about the cattle. I had said it all already, for six days ([[voyage/day-1083-sixth-day]]).

## Afterwards

There was no roll call after this one. A day out, the storm came down ([[voyage/day-1084-the-storm]]). The mast fell on the helmsman and the hull broke apart, and the men went into the sea round the wreck. I lashed the keel and mast together and held on ([[voyage/legs/the-wreck-and-charybdis]]). I did not see any of them come up.

I am adding this paragraph on day 1095, from Ogygia. I have written the count for day 1084 as 31 aboard at sailing, because that is what it was. The next record is not a roll call: [[crew/roll-calls/day-1095]].

## What the record still asks

- [ ] Whether there was anything I could have said on this beach that would have kept them. The oath was already broken: [[oaths/helios]].

Losses: [[crew/losses/thrinacia]]. Ledger: [[crew/_index]].`,
    links: ["crew/eurylochus.md", "crew/roll-calls/day-1095.md", "oaths/helios.md", "crew/losses/thrinacia.md", "crew/_index.md", "voyage/day-1083-sixth-day.md", "voyage/day-1084-the-storm.md", "voyage/legs/the-wreck-and-charybdis.md"],
    fields: { day: 1084, aboard: 31, ships: 1, place: "Thrinacia" },
  },
  {
    path: "crew/roll-calls/day-1095.md",
    title: "Roll call, day 1,095: Ogygia",
    type: "roll-call",
    created: "2019-07-12",
    updated: "2026-07-12",
    status: "closed",
    tags: ["roll-call", "ogygia", "closed"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Zero. Taken on the beach at Ogygia after nine days in the water, out of habit, and closed.",
    body: `Taken on the beach at Ogygia on the tenth night, after nine days on the keel ([[voyage/day-1095-ogygia]]).

| | Count |
|---|---|
| Ships | 0 of 12 |
| Crew | 0 of 600 |
| Survivors | 1, not on the roll |

## Notes

I called the roll anyway. I called it ship by ship, as on day 206, and then called the thirty-one of ship 1 by name, because I had their names and nothing else to do with them. Nobody answered. I knew nobody would. A roll call is how you find out what you already know in a form you can write down.

Then I closed the roll. The crew ledger in [[crew/_index]] closes here: six hundred embarked, six hundred lost, one survivor, no ship returned.

## Since

I have reopened this record once a year to check that the number has not changed. It has not changed. It will not change. I keep reopening it because the alternative is a record that nobody looks at.

Today, day 3652, I opened it to add this line before the raft goes in ([[ogygia/build/departure-checklist]]). There is nobody to count on it. That is not an omission.

See [[people/calypso]] and [[ogygia/island/day-1095-landfall]] for the island and [[crew/families-owed-news]] for what remains.`,
    links: ["crew/_index.md", "people/calypso.md", "crew/families-owed-news.md", "voyage/day-1095-ogygia.md", "ogygia/build/departure-checklist.md", "ogygia/island/day-1095-landfall.md"],
    fields: { day: 1095, aboard: 0, ships: 0, place: "Ogygia" },
  },

  /* ----------------------------------------------------- the crew's records */
  {
    path: "crew/fleet-strength.md",
    title: "Fleet strength over time",
    type: "ledger",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "closed",
    tags: ["ledger", "fleet", "roster"],
    places: ["place:troy", "place:ismarus", "place:cyclopes", "place:laestrygonians", "place:aeaea", "place:scylla", "place:thrinacia", "place:ogygia"],
    summary: "Ships and men by day, from six hundred on the beach at Troy to none on the beach at Ogygia. Every row is a roll call or a loss.",
    body: `One row for every change. Each row is backed by a roll call or a loss record; nothing here is estimated.

| Day | Event | Ships | Crew | Change |
|---|---|---|---|---|
| 3 | sailed from Troy | 12 | 600 | |
| 9 | Ismarus | 12 | 528 | -72 |
| 21 | storm off Cape Malea | 12 | 528 | 0 |
| 30 | Lotus-eaters | 12 | 528 | 0 |
| 96-99 | the Cyclops's cave | 12 | 522 | -6 |
| 171 | Ithaca in sight; the bag | 12 | 522 | 0 |
| 205 | the Laestrygonian harbour | 1 | 38 | -484 |
| 611 | Aeaea, leaving | 1 | 37 | -1 |
| 1043 | the strait, Scylla | 1 | 31 | -6 |
| 1084 | off Thrinacia, the storm | 0 | 0 | -31 |

**Embarked 600. Lost 600. Survivors 1, not on the roll. Ships returned 0.**

## Reading it

Three landfalls in the table cost nothing. That is not the same as saying four landfalls were safe; the Lotus-eaters cost three men their wish to go home, and Aeolia cost us the wind ([[voyage/legs/ithaca-in-sight]]).

One row is most of the total ([[studies/losses-by-hazard]]). Eleven ships in one morning ([[voyage/legs/laestrygonians]]) is 484 of the 600, and no amount of care on the other nine rows would have changed the column much. I keep the table anyway, because the other 116 were on my ship and are on me.

Roll calls: [[crew/roll-calls/day-3]], [[crew/roll-calls/day-206]], [[crew/roll-calls/day-1095]]. Ledger: [[crew/_index]].`,
    links: ["crew/roll-calls/day-3.md", "crew/roll-calls/day-206.md", "crew/roll-calls/day-1095.md", "crew/_index.md", "voyage/legs/ithaca-in-sight.md", "studies/losses-by-hazard.md", "voyage/legs/laestrygonians.md"],
    fields: { embarked: 600, lost: 600, survivors: 1, returned: 0 },
  },
  {
    path: "crew/oar-bench-rota.md",
    title: "Oar-bench rota, ship 1",
    type: "rota",
    created: "2016-07-15",
    updated: "2019-05-21",
    status: "closed",
    tags: ["rota", "ship-1", "oars"],
    places: ["place:troy", "place:scylla"],
    summary: "Who rowed where, and how the benches were re-seated each time the ship came back short. Twenty-four oars a side to start with.",
    body: `Ship 1 was built for forty-eight oars ([[knowledge/oar-counts]]), twenty-four a side, with a helmsman at the stern and a lookout at the stem. Fifty men.

## Seating by stage

| From day | Crew | Oars manned | A side | Resting |
|---|---|---|---|---|
| 3 | 50 | 48 | 24 | 0 |
| 10 | 44 | 42 | 21 | 0 |
| 99 | 38 | 36 | 18 | 0 |
| 611 | 37 | 34 | 17 | 1 |
| 1043 | 31 | 28 | 14 | 1 |

From day 611 there was an odd man. He rested a turn of the glass and then took the place of the next man forward. Nobody asked to be the odd man; I had it go by bench number so it could not be about anyone.

## Rules

- The forward benches are cleared first when the ship is short. The bow is light enough already and the stern oars do more work.
- Two men from the same household do not share a bench. If the ship goes down one at a time, I did not want to make a household pay twice at once. It made no difference in the end, and I would keep the rule again.
- The bow oar on the landward side was always a strong man. At the strait ([[voyage/legs/the-strait]]) that was the seat Scylla reached first: [[crew/scylla-six]].

## Status

Closed day 1084. There is no rota to keep for a raft ([[studies/raft-versus-ship]]) with one man on it, and I will not draw one up for the dead.

See [[crew/ships/ship-01]] and [[crew/_index]].`,
    links: ["crew/scylla-six.md", "crew/ships/ship-01.md", "crew/_index.md", "knowledge/oar-counts.md", "voyage/legs/the-strait.md", "studies/raft-versus-ship.md"],
    fields: { ship: 1, oars: 48, closed: 1084 },
  },
  {
    path: "crew/watch-rota.md",
    title: "Watch rota",
    type: "rota",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "closed",
    tags: ["rota", "watch", "ship-1"],
    places: ["place:aeolia", "place:thrinacia"],
    summary: "Three watches a night, two men to a watch. The rota had no line for the captain, and the two disasters that were not storms happened while the captain slept.",
    body: `## The rota

Beached or at anchor, three watches a night: first, middle, morning. Two men to a watch, one at the hull and one up the beach. The fleet rota ran by ship; after day 205 it ran by bench on ship 1.

At sea, the helmsman and the lookout kept the watch, and I kept it with them as often as I could stay awake.

## What it did not have

There was no line on it for me. I kept watches when I chose and slept when I could not stay up, and nobody was told to stand my watch, because I was the watch.

| Day | I slept | What happened |
|---|---|---|
| 171 | after nine days at the sheet ([[decisions/keep-the-helm-nine-days]]) | the bag was opened ([[voyage/day-171-ithaca-in-sight]]) |
| 1077 | inland, after praying | the cattle were killed ([[voyage/day-1077-the-cattle]]) |

Both times, the crew had kept the rota exactly. The rota was not the problem. The problem was that the one decision nobody else could take was waiting for a man who was asleep.

## If there is ever a crew again

- [ ] The captain's watch goes on the rota, with a named second who can wake him.
- [ ] The second is told what the captain knows. Not some of it. All of it. See [[crew/aeolia-bag]].
- [ ] Nothing that needs a decision is left lying in reach of a crew while the captain sleeps.

There will not be a crew again. The raft has room for one: [[studies/sleep-on-a-single-hand-crossing]]. See [[crew/losses/thrinacia]] and [[crew/_index]].`,
    links: ["crew/aeolia-bag.md", "crew/losses/thrinacia.md", "crew/_index.md", "decisions/keep-the-helm-nine-days.md", "voyage/day-171-ithaca-in-sight.md", "voyage/day-1077-the-cattle.md", "studies/sleep-on-a-single-hand-crossing.md"],
    fields: { watches: 3, men_per_watch: 2, closed: 1084 },
  },
  {
    path: "crew/ismarus-wine-ration.md",
    title: "The Ismarus wine ration",
    type: "ledger",
    created: "2016-07-22",
    updated: "2019-06-23",
    status: "closed",
    tags: ["wine", "ismarus", "ration"],
    places: ["place:ismarus", "place:cyclopes", "place:thrinacia"],
    summary: "Twelve jars of Maron's wine, one cup to twenty of water, and a goatskin of it carried into a cave. Rationed from the day after the wine cost seventy-two.",
    body: `[[people/maron]], the priest of Apollo at Ismarus, gave me twelve jars of sweet unmixed wine for sparing him and his household ([[decisions/spare-maron]], [[oaths/maron-guest-gift]]). It is strong enough that one cup in twenty of water still fills a room with the smell of it. Nobody aboard knew it was in the hold but my steward and me.

The fleet also came away with wine from the sack of the town. It was drunk on the beach that night. That wine is the cause in [[crew/losses/ismarus]].

## The ration

From day 10: one cup of mixed wine per man at the evening meal, mixed one to twenty for Maron's, one to three for anything else. No drinking on the beach on a landing night, ever.

## Maron's twelve jars

| Day | Jars | Note |
|---|---|---|
| 9 | 12 | received, sealed, ship 1 hold |
| 96 | 11 | one decanted into a goatskin for the cave |
| 205 | 9 | |
| 246 | 8 | not opened on Aeaea; Circe kept her own table |
| 1038 | 8 | Circe's stores added for the passage |
| 1044 | 7 | landed on Thrinacia |
| 1058 | 0 | last of Maron's; Circe's skins ran out the next day |

The goatskin went into the Cyclops's cave on day 97. He drank three bowls of it unmixed and asked my name, and fell asleep ([[voyage/day-98-the-stake]]). Without it we would still be in there. See [[crew/cave-party]].

## Closed

When the wine and grain were gone on Thrinacia, the men fished and trapped birds, and then they did not. See [[crew/thrinacia-provisions]].

Ledger: [[crew/_index]].`,
    links: ["crew/losses/ismarus.md", "crew/cave-party.md", "crew/thrinacia-provisions.md", "crew/_index.md", "people/maron.md", "decisions/spare-maron.md", "oaths/maron-guest-gift.md", "voyage/day-98-the-stake.md"],
    fields: { source: "Maron, priest of Apollo", jars: 12, mix: "one to twenty", closed: 1059 },
  },
  {
    path: "crew/lotus-eaters.md",
    title: "The three who ate the lotus",
    type: "record",
    created: "2016-08-11",
    updated: "2017-02-03",
    status: "closed",
    tags: ["lotus", "ship-1", "recovery"],
    places: ["place:lotus"],
    summary: "Two men and a herald from ship 1, sent inland to see who lived there. They were offered the lotus and stopped wanting to go home.",
    body: `**Day:** 30 ([[voyage/day-30-lotus-eaters]]). **Ship:** 1. **Sent:** two men and a herald, to find out what people lived on that shore. **Lost:** none.

## What happened

We had watered and eaten on the beach after nine days of storm. I sent three men inland. The people there did them no harm. They gave them the lotus ([[knowledge/lotus]]) to eat, and every one of the three who ate it lost all wish to come back or send word, and wanted only to stay among the lotus-eaters and eat, and forget the way home.

I went and fetched them. They wept and would not walk. We carried them to the ships and tied them under the benches ([[decisions/drag-back-the-lotus-eaters]]).

## Recovery

| Day | State |
|---|---|
| 30 | carried aboard, tied |
| 31 | present at roll call; answering as if from a distance |
| 34 | untied; rowing; asking where we were bound |
| 40 | asking when we would reach Ithaca, which is how I knew |

All three were aboard ship 1 at the Laestrygonian harbour and after. They are counted in the ship's roll, by bench, and are not marked separately in any later loss. I have chosen not to mark them. They came back.

## What the record still asks

- [ ] Whether any of them remembered the taste of it. One said he did not. The other two did not answer.
- [ ] Whether forgetting the way home is a loss that belongs in a ledger. I have not put it in this one.

See [[crew/roll-calls/day-31]], [[crew/ships/ship-08]] for the four who helped carry them, and [[crew/_index]].`,
    links: ["crew/roll-calls/day-31.md", "crew/ships/ship-08.md", "crew/_index.md", "voyage/day-30-lotus-eaters.md", "knowledge/lotus.md", "decisions/drag-back-the-lotus-eaters.md"],
    fields: { day: 30, ship: 1, party: 3, lost: 0 },
  },
  {
    path: "crew/cave-party.md",
    title: "The cave party",
    type: "record",
    created: "2016-10-16",
    updated: "2026-07-08",
    status: "closed",
    tags: ["cyclopes", "cave", "ship-1"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Twelve picked men from ship 1 and a goatskin of Maron's wine. Six came out with me under the rams.",
    body: `**Day:** 97 in, 99 out. **Ship:** 1. **Party:** twelve, picked by me, myself not counted.

## The twelve

I picked the best twelve of the forty-four, for a visit to a man I had not met who kept a well-stocked cave. That was the brief I gave myself: [[decisions/enter-the-cave]].

| Outcome | Count | When |
|---|---|---|
| Eaten | 2 | day 97, evening |
| Eaten | 2 | day 98, morning |
| Eaten | 2 | day 98, evening; [[crew/antiphus]] the last |
| Came out under the rams | 6 | day 99, morning |

## The stake

On the second day ([[voyage/day-98-the-stake]]) I cut a length from the olive trunk he had left to season, sharpened it, hardened it in the fire, and hid it under the dung. Four of the men drew lots for who would help me drive it in. The lots fell on the four I would have chosen myself, and I was the fifth.

## The rams

Each man went out tied under the middle of three rams. I went out under the lead ram, holding the fleece ([[voyage/day-99-escape]]).

## What the record still asks

- [ ] The men wanted to take the cheeses and lambs and go before the owner came back. I wanted to see him ([[decisions/wait-for-polyphemus]]). The six are mine.
- [ ] I have not used the name I gave him since. See [[notes/do-not-give-my-name]].

See [[crew/losses/cyclopes]], [[crew/ismarus-wine-ration]] and [[crew/_index]].`,
    links: ["crew/antiphus.md", "notes/do-not-give-my-name.md", "crew/losses/cyclopes.md", "crew/ismarus-wine-ration.md", "crew/_index.md", "decisions/enter-the-cave.md", "voyage/day-98-the-stake.md", "voyage/day-99-escape.md", "decisions/wait-for-polyphemus.md"],
    fields: { day: 97, ship: 1, party: 12, lost: 6, returned: 6 },
  },
  {
    path: "crew/aeolia-bag.md",
    title: "The bag of winds",
    type: "record",
    created: "2016-12-30",
    updated: "2026-07-08",
    status: "closed",
    tags: ["aeolia", "ship-1", "trust"],
    places: ["place:aeolia", "place:ithaca"],
    summary: "Aeolus bound the adverse winds into an oxhide bag and tied it with a silver cord. I did not tell the crew what was in it, and on day 171 they found out.",
    body: `**Day:** 171. **Ship:** 1. **Lost:** none. **Cost:** the way home, and [[people/aeolus]]'s help.

## What was in it

Every wind except the one we needed, bound in a bag of oxhide and tied to the deck with a silver cord so that none could slip out. The west wind ([[knowledge/zephyrus]]) was left free to blow us home.

## What the crew knew

Nothing. I stowed it, tied it, held the sheet myself for nine days and nights, and told nobody what it was ([[decisions/accept-the-bag-of-winds]]). On the tenth day we could see Ithaca, and I slept ([[voyage/day-171-ithaca-in-sight]]).

The men talked among themselves. They said I was bringing home gold and silver from Aeolus on top of my share of Troy, and they were going home with empty hands after the same voyage. They untied the bag.

## No name on this record

I have not written down who untied it. I did not ask, then or afterwards, and I am not going to guess now. The crew acted on what they knew. What they knew was what I had told them, and I had told them nothing.

## What I would do

- Tell the whole ship what is in the hold, every time.
- Name a second who knows everything the captain knows: [[crew/watch-rota]].
- Not hold the sheet nine days alone.

## What the record still asks

- [ ] Whether they would have left it alone if they had known. I think so. I would like to have found out.

Roll call afterwards: [[crew/roll-calls/day-172]]. Ledger: [[crew/_index]].`,
    links: ["crew/watch-rota.md", "crew/roll-calls/day-172.md", "crew/_index.md", "people/aeolus.md", "knowledge/zephyrus.md", "decisions/accept-the-bag-of-winds.md", "voyage/day-171-ithaca-in-sight.md"],
    fields: { day: 171, ship: 1, lost: 0, cost: "the way home" },
  },
  {
    path: "crew/aeaea-scouting-party.md",
    title: "The scouting party on Aeaea",
    type: "record",
    created: "2017-03-17",
    updated: "2026-07-08",
    status: "closed",
    tags: ["aeaea", "ship-1", "scouting"],
    people: ["person:eurylochus", "person:circe"],
    places: ["place:aeaea"],
    summary: "Thirty-eight split by lot into two companies. Eurylochus and twenty-two went up to the house in the clearing; fifteen stayed with me at the ship. The twenty-two were penned as swine.",
    body: `**Day:** 247, the morning after the stag; the men restored on day 248. **Ship:** 1, thirty-eight aboard. **Lost:** none, in the end.

## The split

I divided the crew into two companies and gave one to [[crew/eurylochus]]. We shook lots in a helmet. His came out ([[decisions/split-the-crew-on-aeaea]]).

| Company | Leader | Men | Where |
|---|---|---|---|
| A | Eurylochus | 22 | up to the house in the clearing |
| B | myself | 15 | at the ship |
| | | **22 + 15 + Eurylochus = 38** | |

## The house

There were wolves and mountain lions round the house, tame, fawning. A woman was singing at a loom inside. [[crew/polites]] said to call to her. She asked them in and gave them cheese and barley and honey in wine, with a drug in it ([[knowledge/circe-drugs]]), and struck them with a wand, and they had the heads and bristles and voices of swine, but their minds stayed as they were. She penned them in the sties.

Eurylochus waited outside, suspecting a trap, and came back to the ship alone and could not speak for some time.

## The restoration

I went up alone. [[people/hermes]] met me on the path and gave me the herb, moly, against her drug. [[people/circe]] could not change me, and swore an oath to do no more harm ([[oaths/circe-no-harm]]), and turned the twenty-two back into men. They came out younger than they went in.

## Count

Thirty-eight down to the beach and thirty-eight back. The only losses on Aeaea came a year later: [[crew/losses/aeaea]].

Ledger: [[crew/_index]].`,
    links: ["crew/eurylochus.md", "crew/polites.md", "people/circe.md", "crew/losses/aeaea.md", "crew/_index.md", "decisions/split-the-crew-on-aeaea.md", "knowledge/circe-drugs.md", "people/hermes.md", "oaths/circe-no-harm.md"],
    fields: { day: 247, ship: 1, party: 23, transformed: 22, lost: 0 },
  },
  {
    path: "crew/barrow-on-aeaea.md",
    title: "Elpenor's barrow",
    type: "record",
    created: "2018-03-28",
    updated: "2026-07-08",
    status: "closed",
    tags: ["burial", "aeaea", "elpenor"],
    people: ["person:elpenor"],
    places: ["place:aeaea"],
    summary: "Burned with his armour, a barrow raised on the headland, and his oar planted on top. The only grave of the six hundred.",
    body: `**Day:** 624. **Where:** the headland above the beach on Aeaea, where the shore runs out furthest. **For:** [[crew/elpenor]].

## What he asked

At the pit on day 620 ([[voyage/day-620-acheron]]) he asked me not to leave him unwept and unburied, or he would be the cause of the gods' anger against me. He asked to be burned with all the armour he had, and a mound heaped up for him on the shore of the grey sea, so that men to come would know of an unlucky man, and his oar planted on the mound, the oar he rowed with while he was alive among his companions.

## What was done

- [x] Body brought down from Circe's house, where it had lain since day 611.
- [x] Timber cut on the headland.
- [x] Burned with his armour.
- [x] Barrow heaped over the ashes.
- [x] A stone set up on the barrow.
- [x] His oar planted at the top of it, blade up.
- [x] Wept for, by every man aboard.

## The record

| | |
|---|---|
| Graves of the six hundred | 1 |
| This grave | Elpenor's |
| Oar | his own, from ship 1 |
| Witnesses | 37 and myself |

Of everyone on this voyage, he is the one whose family I can tell exactly where he lies. That is a thing I will be able to say, and I am grateful for it in a way I did not expect.

Log: [[voyage/day-624-elpenor-buried]]. Promise: [[oaths/promise-to-elpenor]]. See [[crew/burials-and-cenotaphs]], [[crew/promises-to-the-dead]] and [[crew/_index]].`,
    links: ["crew/elpenor.md", "crew/burials-and-cenotaphs.md", "crew/promises-to-the-dead.md", "crew/_index.md", "voyage/day-620-acheron.md", "voyage/day-624-elpenor-buried.md", "oaths/promise-to-elpenor.md"],
    fields: { day: 624, place: "Aeaea", for: "Elpenor", status_of_promise: "kept" },
  },
  {
    path: "crew/sirens-wax.md",
    title: "Wax for the Sirens",
    type: "checklist",
    created: "2019-05-19",
    updated: "2019-05-19",
    status: "closed",
    tags: ["sirens", "ship-1", "checklist"],
    people: ["person:circe"],
    places: ["place:sirens"],
    summary: "One cake of wax, cut and kneaded and pressed into thirty-seven pairs of ears by hand. Then the rope.",
    body: `**Day:** 1041 ([[voyage/day-1041-sirens]]). **Ship:** 1. **Aboard:** 37. **Lost:** none.

[[people/circe]] gave the method and I followed it to the letter.

## Before the meadow

- [x] Told the crew the whole of what Circe said, as far as it concerned them. (Not the strait. That was a different decision: [[decisions/what-to-tell-the-crew]].)
- [x] Cut a large cake of wax into small pieces with my sword.
- [x] Kneaded it in my hands until the sun and the pressure softened it.
- [x] Stopped the ears of every man, one after the other, down the benches. Thirty-seven men, seventy-four ears.
- [x] Stood against the mast.
- [x] Had them bind me hand and foot, upright, the ropes tied to the mast itself.
- [x] Told them: if I beg, tighten it ([[oaths/sirens-binding-order]]).

## Passing

The wind dropped and the sea went flat ([[omens/day-1041-calm]]). The men took the sail down and rowed. The singing began when we were within a shout of the shore. I begged. [[crew/perimedes]] and [[crew/eurylochus]] got up and put more rope on me. Nobody else so much as turned his head, because nobody else could hear a thing.

## After

- [x] Rowed until the singing was gone, and then for as long again.
- [x] Untied.
- [x] Took the wax out. Every man asked what it had been like. I told them.

The count at the strait two days later starts from thirty-seven: [[crew/roll-calls/day-1043]]. See [[knowledge/sirens]] and [[crew/_index]].`,
    links: ["people/circe.md", "crew/perimedes.md", "crew/eurylochus.md", "crew/roll-calls/day-1043.md", "knowledge/sirens.md", "crew/_index.md", "voyage/day-1041-sirens.md", "decisions/what-to-tell-the-crew.md", "oaths/sirens-binding-order.md", "omens/day-1041-calm.md"],
    fields: { day: 1041, ship: 1, aboard: 37, lost: 0 },
  },
  {
    path: "crew/scylla-six.md",
    title: "The six for Scylla",
    type: "record",
    created: "2019-05-21",
    updated: "2026-07-08",
    status: "closed",
    tags: ["scylla", "ship-1", "roster"],
    places: ["place:scylla"],
    summary: "Six seats on the cliff side, forward. The strongest arms on the ship were there, because I had put them there.",
    body: `**Day:** 1043 ([[voyage/legs/the-strait]]). **Ship:** 1. **Taken:** 6, from the deck, in one pass.

The six are listed by where they sat, because that is what decided it. Each of them has a name in the ship's roll and each name was called and not answered at [[crew/roll-calls/day-1043]].

| Seat | Side | Duty | Note |
|---|---|---|---|
| bow oar | cliff side | first stroke | strongest arm aboard |
| bench 2 | cliff side | oar | |
| bench 3 | cliff side | oar | |
| bench 4 | cliff side | oar | |
| bench 5 | cliff side | oar | |
| stem | -- | lookout | was watching Charybdis, as ordered |

## Why those six

I had seated the strongest rowers forward on the cliff side for the passage, so that the ship would hold close under the rock and well away from Charybdis. It did. The heads came down from above on the side nearest them. The seating that kept the ship away from the whirlpool is the seating that chose the six.

I had been told the count by [[people/circe]]. I had not been told the seats. I chose them without thinking of it in those terms.

## What the record still asks

- [ ] Whether I would seat it differently. No. Anywhere else, the ship goes into Charybdis and the count is thirty-seven.
- [ ] Whether they should have been told. That question has its own record: [[decisions/scylla-or-charybdis]], and [[decisions/what-to-tell-the-crew]].
- [ ] They called out my name as they were lifted. I have not decided what that asks.

See [[crew/oar-bench-rota]], [[crew/losses/scylla]] and [[crew/_index]].`,
    links: ["crew/roll-calls/day-1043.md", "decisions/scylla-or-charybdis.md", "crew/oar-bench-rota.md", "crew/losses/scylla.md", "crew/_index.md", "voyage/legs/the-strait.md", "people/circe.md", "decisions/what-to-tell-the-crew.md"],
    fields: { day: 1043, ship: 1, taken: 6, side: "cliff side, forward" },
  },
  {
    path: "crew/oath-signatories.md",
    title: "Who swore the oath on Thrinacia",
    type: "record",
    created: "2019-05-22",
    updated: "2026-07-08",
    status: "closed",
    tags: ["oath", "thrinacia", "roster"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Thirty-one men swore, every one aboard. Sworn aloud on the beach, witnessed by me, and broken by every one of them.",
    body: `**Sworn:** on the beach at Thrinacia, before anyone went inland ([[voyage/day-1044-thrinacia-landfall]]). **Text and standing:** [[oaths/helios]].

Nobody signs an oath. They swear it aloud, each in his own voice, and somebody hears it. I heard every one and wrote down that I had.

## The roll of the oath

| | Count | Sworn | Kept |
|---|---|---|---|
| [[crew/eurylochus]], second in command | 1 | yes | no |
| [[crew/perimedes]] | 1 | yes | no |
| [[crew/polites]] | 1 | yes | no |
| helmsman | 1 | yes | no |
| lookout | 1 | yes | no |
| benches, by number | 26 | yes | no |
| **Total** | **31** | **31** | **0** |

## The words

That if we found a herd of cattle or a great flock of sheep, no man would kill a single beast in any reckless folly, but would eat in peace the food that Circe gave. Every man swore it as I asked, and when they had sworn and finished the oath, we moored the ship.

## What the record does not show

Who spoke against it on day 1077 ([[voyage/day-1077-the-cattle]]), and who said nothing, and who held back. I was asleep inland. The record shows that all thirty-one ate, because there were six days of eating and nobody went without.

I did not eat.

## What the record still asks

- [ ] Whether an oath sworn by a man too tired to row is the same oath. I asked for it when they could barely stand ([[decisions/land-on-thrinacia]]). That is when I needed it.

See [[decisions/cattle-of-helios]], [[crew/losses/thrinacia]] and [[crew/_index]].`,
    links: ["oaths/helios.md", "crew/eurylochus.md", "crew/perimedes.md", "crew/polites.md", "decisions/cattle-of-helios.md", "crew/losses/thrinacia.md", "crew/_index.md", "voyage/day-1044-thrinacia-landfall.md", "voyage/day-1077-the-cattle.md", "decisions/land-on-thrinacia.md"],
    fields: { place: "Thrinacia", sworn: 31, kept: 0, witness: "Odysseus" },
  },
  {
    path: "crew/thrinacia-provisions.md",
    title: "Provisions on Thrinacia",
    type: "ledger",
    created: "2019-05-22",
    updated: "2019-06-24",
    status: "closed",
    tags: ["provisions", "thrinacia", "hunger"],
    places: ["place:thrinacia"],
    summary: "Circe's stores and the last of Maron's wine, for thirty-one men, for a wind that did not come. Every line in this table ends at the herds.",
    body: `Thirty-one men aboard. A south wind ([[knowledge/notus]]) and an east wind ([[knowledge/eurus]]), and nothing else, for a month.

## Stores

| Day | Grain | Wine | Note |
|---|---|---|---|
| 1044 | Circe's, full | 7 jars of Maron's, Circe's skins | landed |
| 1052 | half | Maron's 3 jars | ration cut |
| 1058 | quarter | Maron's gone | |
| 1059 | quarter | none | last of Circe's wine |
| 1062 | none | none | last of everything ([[voyage/day-1062-stores-out]]) |
| 1063 | -- | -- | fishing with bent hooks; trapping birds |
| 1077 | -- | -- | the herds |

While there was grain and wine, nobody went near the cattle. The oath held exactly as long as the stores did. I am not saying that to excuse anyone. I am saying it because it is the most useful line in the table, and I did not see it until afterwards.

## Fishing

Hooks bent from whatever bronze we had: pins, the edge of a cauldron. The catch kept men alive and did not keep them strong. Birds came to snares in the scrub above the beach, few.

## What the record still asks

- [ ] Whether I should have rowed out against the wind on half rations rather than wait. Teiresias and Circe both told me to avoid this island altogether ([[decisions/land-on-thrinacia]]). I had argued for that already, and lost to a crew that could not row another night: see [[crew/dissent-log]].
- [ ] Whether a month's food for thirty-one could have been carried out of Aeaea if I had asked Circe for it. I did not ask.

See [[crew/ismarus-wine-ration]], [[crew/losses/thrinacia]] and [[crew/_index]].`,
    links: ["crew/dissent-log.md", "crew/ismarus-wine-ration.md", "crew/losses/thrinacia.md", "crew/_index.md", "knowledge/notus.md", "knowledge/eurus.md", "voyage/day-1062-stores-out.md", "decisions/land-on-thrinacia.md"],
    fields: { aboard: 31, landed: 1044, stores_out: 1062 },
  },
  {
    path: "crew/dissent-log.md",
    title: "Dissent log",
    type: "log",
    created: "2016-10-19",
    updated: "2019-06-24",
    status: "closed",
    tags: ["dissent", "eurylochus", "ship-1"],
    people: ["person:eurylochus"],
    places: ["place:cyclopes", "place:aeaea", "place:thrinacia"],
    summary: "Every time the crew argued against my orders out loud and I wrote it down. Three of the entries are Eurylochus's.",
    body: `A log of open disagreement. I kept it because a captain who only writes down the orders forgets the arguments, and the arguments are where the mistakes show first.

| Day | Who | Against | Who was right |
|---|---|---|---|
| 9 | the shore parties | sailing from Ismarus at once ([[decisions/stay-the-night-at-ismarus]]) | I was; seventy-two died |
| 97 | the cave party | waiting for the owner of the cave ([[decisions/wait-for-polyphemus]]) | they were |
| 99 | [[crew/eurylochus]] | the cave, in writing, afterwards | he was |
| 248 | Eurylochus | going back up to Circe's house ([[decisions/go-to-circe-alone]]) | I was |
| 1044 | Eurylochus, for the crew | rowing past Thrinacia in the dark ([[decisions/land-on-thrinacia]]) | I was; it ended the ship |

## Eurylochus

He disagreed with me in writing three times and was right once. The first time was about the cave, and he was right: the six were my choice. The second was on Aeaea, when he called Circe's house a trap and said I would get them all killed as I had in the cave; I nearly drew on him, and the men held me back. He came up behind us in the end. The third was about landing on the island of the herds, and it ended the ship. What he said to the men on day 1077 while I slept is not in this log, because I was not there to hear it.

## What this log is for

- It is not a list of grievances. Everyone on it is dead.
- It is a check on the decision records: every row above that I lost should have a matching entry in [[decisions/_index]], and every row I won should be tested against what happened afterwards.

See [[crew/losses/thrinacia]] and [[crew/_index]].`,
    links: ["crew/eurylochus.md", "decisions/_index.md", "crew/losses/thrinacia.md", "crew/_index.md", "decisions/stay-the-night-at-ismarus.md", "decisions/wait-for-polyphemus.md", "decisions/go-to-circe-alone.md", "decisions/land-on-thrinacia.md"],
    fields: { entries: 5, eurylochus: 3, closed: 1084 },
  },
  {
    path: "crew/standing-orders.md",
    title: "Standing orders",
    type: "checklist",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "closed",
    tags: ["orders", "fleet", "discipline"],
    places: ["place:troy"],
    summary: "Read out on the beach at Troy and added to after every lesson. Each order with the day it was added and whether it was kept.",
    body: `Read out to every crew on day 3 and again whenever one was added. Each was added because something went wrong without it.

| Added | Order | Kept |
|---|---|---|
| 3 | Count every crew at every landing. | yes |
| 3 | No man ashore alone. | yes |
| 10 | No drinking on the beach on a landing night. Wine mixed and rationed. | yes |
| 10 | When the order to sail is given, sail. | broken at Thrinacia, day 1044 ([[decisions/land-on-thrinacia]]) |
| 31 | Eat nothing given to you by people we do not know ([[knowledge/lotus]]). | yes |
| 99 | Give no name ashore. Least of all mine. | broken by me, the same day |
| 172 | Nothing aboard is opened that the captain has not explained ([[voyage/day-172-aeolus-refuses]]). | yes; nothing else was ever left unexplained |
| 206 | Moor outside the harbour, never inside a closed one ([[decisions/moor-outside-the-harbour]]). | yes |
| 620 | **No embarkation without a roll call.** | yes, every time after |
| 1044 | No hand on the herds of the sun. | broken by all |

## Notes

- Day 99: the name order was in my own notes before we went into the cave: [[notes/do-not-give-my-name]]. I broke it from the stern. See [[decisions/name-at-the-stern]].
- Day 620: this one should have been on the list from day 3. It was not, because I thought "count at every landing" covered it. A landing and a leaving are different things. [[crew/roll-calls/day-620]].
- Day 1044: [[oaths/helios]].

## Status

Closed with the crew. One order still applies, to a crew of one: give no name until you are sure of the house.

Ledger: [[crew/_index]].`,
    links: ["notes/do-not-give-my-name.md", "decisions/name-at-the-stern.md", "crew/roll-calls/day-620.md", "oaths/helios.md", "crew/_index.md", "decisions/land-on-thrinacia.md", "knowledge/lotus.md", "voyage/day-172-aeolus-refuses.md", "decisions/moor-outside-the-harbour.md"],
    fields: { orders: 10, broken: 3 },
  },
  {
    path: "crew/helmsmen.md",
    title: "The twelve helmsmen",
    type: "roster",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "closed",
    tags: ["helmsmen", "fleet", "roster"],
    places: ["place:malea", "place:laestrygonians", "place:charybdis", "place:thrinacia"],
    summary: "One man at the steering oar of each ship. Eleven lost in the harbour on the same morning; mine killed by the mast in the storm.",
    body: `Each ship had one helmsman, chosen by her own crew and confirmed by me at Troy. They are recorded here by ship because a fleet sails as well as its twelve steering oars.

| Ship | From | Note | Lost |
|---|---|---|---|
| 1 | Ithaca | held off the smoke and surf of Charybdis on my order | day 1084 |
| 2 | Ithaca | | day 205 |
| 3 | Ithaca | | day 205 |
| 4 | Ithaca | wounded at Ismarus; steered on one leg | day 205 |
| 5 | Ithaca | | day 205 |
| 6 | Same | steered under tow off Malea | day 205 |
| 7 | Same | towed ship 6 for a day and a night | day 205 |
| 8 | Same | | day 205 |
| 9 | Zacynthus | at Troy from the first landing | day 205 |
| 10 | Zacynthus | | day 205 |
| 11 | the mainland | | day 205 |
| 12 | the mainland | first into the harbour | day 205 |

## Ship 1

At the strait ([[voyage/legs/the-strait]]) I told him what I had told nobody else: keep the ship away from the smoke and the surf, and hold her close under the cliff. He did. I did not tell him why the cliff was the better side, and he did not ask. He was the best steersman I have sailed with ([[knowledge/steering-oar]]).

In the storm off Thrinacia ([[voyage/day-1084-the-storm]]) the mast came down across the stern ([[knowledge/mast-stepping]]) and struck his head and broke his skull, and he fell from the deck like a diver. He was the first of the thirty-one.

## What the record still asks

- [ ] Every blank in the note column above is a man I did not write enough about while I could.

See [[crew/ships/ship-01]], [[knowledge/charybdis]] and [[crew/_index]].`,
    links: ["crew/ships/ship-01.md", "knowledge/charybdis.md", "crew/_index.md", "voyage/legs/the-strait.md", "knowledge/steering-oar.md", "voyage/day-1084-the-storm.md", "knowledge/mast-stepping.md"],
    fields: { helmsmen: 12, lost: 12 },
  },
  {
    path: "crew/shares-owed.md",
    title: "Shares owed",
    type: "ledger",
    created: "2016-07-15",
    updated: "2026-07-08",
    status: "open",
    tags: ["shares", "plunder", "families"],
    places: ["place:troy", "place:ismarus", "place:ithaca"],
    summary: "Six hundred shares of Troy and six hundred of Ismarus, seventy-two of them held for the dead. Every one lost with the ships. Still owed.",
    body: `Every man who sailed from Troy had a share of the plunder, stowed in his ship by his own bench ([[voyage/day-3-departure]]). The Ismarus spoil ([[decisions/raid-ismarus]]) was divided the same way, so that no man went cheated of his portion.

## Held and lost

| Share | Men | Where held | Now |
|---|---|---|---|
| Troy | 600 | each man's own ship | lost with the ships |
| Ismarus | 528 | each survivor's own ship | lost with the ships |
| Ismarus, the 72 | 72 | held by their ships for their families | lost with the ships |
| The Cyclops's flock | 522 | shared across all twelve ships | eaten on the island of goats ([[voyage/day-99-escape]]) |

Ships 2 to 12 went down with their holds on day 205. Ship 1 went down with hers on day 1084. I came ashore on Ogygia with nothing.

## Owed

| To | Households |
|---|---|
| Ithaca | 231 |
| Same | 139 |
| Zacynthus | 94 |
| the mainland opposite | 97 |
| **Total** | **561** |

Some households lost more than one man. A share is owed per man, not per household.

## Settled from

- [ ] The estate, when there is an estate to settle from. It is being eaten by a hall full of guests as I write this: [[ithaca/estate]], [[ithaca/stores/drawdown]].
- [ ] Nothing is settled until the families have been told. The order is: news first, share second. See [[crew/how-to-tell-a-family]].

See [[crew/families-owed-news]] and [[crew/_index]].`,
    links: ["ithaca/estate.md", "crew/how-to-tell-a-family.md", "crew/families-owed-news.md", "crew/_index.md", "voyage/day-3-departure.md", "decisions/raid-ismarus.md", "voyage/day-99-escape.md", "ithaca/stores/drawdown.md"],
    fields: { shares_troy: 600, shares_ismarus: 600, households: 561, settled: 0 },
  },
  {
    path: "crew/families-owed-news.md",
    title: "Families owed news",
    type: "list",
    created: "2016-07-15",
    updated: "2026-07-12",
    status: "open",
    tags: ["families", "ithaca", "news"],
    places: ["place:ithaca"],
    summary: "Five hundred and sixty-one households on four coasts, by island. Counts only. Each of them has been waiting ten years for a ship.",
    body: `Kept by island, from the roll at Troy. Counts only; the names are in the roll, and I will say them in person. Some households sent more than one man.

| Island | Ships | Men | Households |
|---|---|---|---|
| Ithaca | 1-5 | 250 | 231 |
| Same | 6-8 | 150 | 139 |
| Zacynthus | 9-10 | 100 | 94 |
| the mainland opposite | 11-12 | 100 | 97 |
| **Total** | **12** | **600** | **561** |

## By where the news is from

| Island | Ismarus | Cyclopes | Harbour | Aeaea | Scylla | Thrinacia |
|---|---|---|---|---|---|---|
| Ithaca | 30 | 6 | 176 | 1 | 6 | 31 |
| Same | 18 | 0 | 132 | 0 | 0 | 0 |
| Zacynthus | 12 | 0 | 88 | 0 | 0 | 0 |
| mainland | 12 | 0 | 88 | 0 | 0 | 0 |

Every family from Same, Zacynthus and the mainland lost its men at Ismarus or in the one harbour. Ithaca is the only island that has to hear all six places.

## What I know of their state

Nothing direct. The household has had no instructions for twenty years. If they have heard anything, they will have heard it from the other ships that came home from Troy, which can only have said that we sailed and did not arrive ([[ithaca/telemachus/what-he-heard]]).

## Open

- [ ] Ithaca first, in person. On [[ithaca/homecoming-checklist]].
- [ ] Same, across the channel, in person.
- [ ] Zacynthus and the mainland, in person, before the winter.
- [ ] Nobody hears it from a herald. See [[crew/how-to-tell-a-family]].

See [[crew/shares-owed]], [[ithaca/_index]] and [[crew/_index]].`,
    links: ["crew/how-to-tell-a-family.md", "crew/shares-owed.md", "ithaca/_index.md", "crew/_index.md", "ithaca/telemachus/what-he-heard.md", "ithaca/homecoming-checklist.md"],
    fields: { households: 561, men: 600, told: 0 },
  },
  {
    path: "crew/how-to-tell-a-family.md",
    title: "How to tell a family",
    type: "procedure",
    created: "2019-07-20",
    updated: "2026-07-12",
    status: "open",
    tags: ["families", "procedure", "news"],
    places: ["place:ithaca"],
    summary: "Written on Ogygia for five hundred and sixty-one doors. In person, standing, with the man's name first and the count last.",
    body: `Written in the first month on Ogygia, and revised once a year since. I have had a long time to get it right and I am still not sure I have.

## Before

- [ ] Go myself. Not a herald, not Telemachus, not a letter.
- [ ] Go to the oldest house first, not the nearest.
- [ ] Have the roll. Know his ship, his bench, and the day.
- [ ] Have nothing in my hands.

## At the door

1. Say his name before anything else, so they know which of them I have come about.
2. Say he is dead. Do not make them wait for it.
3. Say where, and on what day.
4. Say what he was doing. Every man on the roll was doing something.
5. If it was my choice that killed him, say so. The cave ([[decisions/wait-for-polyphemus]]), the strait ([[decisions/scylla-or-charybdis]]). Do not say the gods did what I did.
6. If it was his, say what he chose and do not judge it. Ismarus ([[decisions/stay-the-night-at-ismarus]]), the cattle ([[decisions/cattle-of-helios]]).
7. Answer what they ask. Do not tell them what they have not asked.
8. Say what is owed, and that it will be paid. Only after all the rest.

## What not to say

- That he died well. They will decide that.
- That he was missed. Unless he was; Elpenor was not, and his family should hear that from me too.
- The count. One house does not need to know the number six hundred. It needs to know the number one.

## Afterwards

- [ ] Mark the household told in [[crew/families-owed-news]].
- [ ] Settle the share: [[crew/shares-owed]].

See [[crew/_index]].`,
    links: ["crew/families-owed-news.md", "crew/shares-owed.md", "crew/_index.md", "decisions/wait-for-polyphemus.md", "decisions/scylla-or-charybdis.md", "decisions/stay-the-night-at-ismarus.md", "decisions/cattle-of-helios.md"],
    fields: { written: "Ogygia", doors: 561, revised: "yearly" },
  },
  {
    path: "crew/burials-and-cenotaphs.md",
    title: "Burials and cenotaphs",
    type: "ledger",
    created: "2016-07-21",
    updated: "2026-07-08",
    status: "open",
    tags: ["burial", "rites", "fleet"],
    places: ["place:ismarus", "place:aeaea", "place:ithaca"],
    summary: "One grave in six hundred. For everyone else, what rites were possible, where, and what is still owed.",
    body: `A man left unburied is a man whose shade cannot cross. That is what Elpenor told me at the pit ([[oaths/promise-to-elpenor]]), and it applies to every name on the roll.

## By place

| Place | Lost | Bodies | Rite given | Owed |
|---|---|---|---|---|
| Ismarus | 72 | left on the beach | each name called three times from the ships | cenotaph |
| the cave | 6 | none | names called on the island of goats | cenotaph |
| the harbour | 484 | none recovered | names called at sea, ship by ship ([[voyage/day-206-one-ship]]) | cenotaph |
| Aeaea | 1 | yes | burned, barrow, oar | nothing; kept |
| Scylla | 6 | none | names called beyond the strait | cenotaph |
| Thrinacia | 31 | the sea | names called on Ogygia | cenotaph |

## The calling

Before we left Ismarus, we stood off the beach and every ship called each of its six three times ([[voyage/day-10-ismarus-morning-after]]). It is the oldest rite there is for men who cannot be carried home, and it costs nothing but the time, and we took the time with the Cicones still on the beach. I made it the practice after every loss.

The thirty-one were called on the beach at Ogygia on the night I came ashore ([[ogygia/island/day-1095-landfall]]). Nobody else was there to call with me.

## Owed

- [x] Elpenor: [[crew/barrow-on-aeaea]].
- [ ] Everyone else: an empty mound for each ship on Ithaca, with the names. Plan: [[crew/cenotaph-plan]].

See [[crew/promises-to-the-dead]] and [[crew/_index]].`,
    links: ["crew/barrow-on-aeaea.md", "crew/cenotaph-plan.md", "crew/promises-to-the-dead.md", "crew/_index.md", "oaths/promise-to-elpenor.md", "voyage/day-206-one-ship.md", "voyage/day-10-ismarus-morning-after.md", "ogygia/island/day-1095-landfall.md"],
    fields: { graves: 1, cenotaphs_owed: 12, names_called: 599 },
  },
  {
    path: "crew/cenotaph-plan.md",
    title: "Cenotaph plan",
    type: "plan",
    created: "2019-08-01",
    updated: "2026-07-12",
    status: "open",
    tags: ["cenotaph", "ithaca", "rites"],
    places: ["place:ithaca"],
    summary: "Twelve empty mounds on Ithaca, one for each ship, with the names cut in stone. Planned on Ogygia, where there is plenty of time to plan.",
    body: `**Where:** the headland above the harbour of Phorcys ([[ithaca/island/harbour-of-phorcys]]), where every ship that leaves Ithaca can see it. **When:** after the families are told, not before.

## The mounds

One for each ship. Ship 1's mound is shared by fifty men who died in five places; the others hold fifty who died in two.

| Mound | Ship | Names | Note |
|---|---|---|---|
| 1 | ship 1 | 50 | Elpenor's name included, though he has his own barrow |
| 2-5 | Ithaca ships | 50 each | |
| 6-8 | Same ships | 50 each | or on Same, if the families ask |
| 9-10 | Zacynthus ships | 50 each | or on Zacynthus |
| 11-12 | mainland ships | 50 each | or on the mainland |

Elpenor's name goes on mound 1 as well as on his own barrow. He has a grave. He also had a ship, and his name belongs with his bench.

## Tasks

- [ ] Ask each island where it wants its mounds. Not decided by me.
- [ ] Stone for the names: twelve slabs, cut on Ithaca.
- [ ] Earth heaped by the families who want to help, and by the household for those who cannot.
- [ ] A sacrifice for the dead at each, from the estate's herds. Not yet affordable: [[ithaca/estate]], [[ithaca/stores/cattle]].
- [ ] Each name read aloud at the raising, three times.

## Blocking

Everything above needs me on Ithaca ([[ithaca/homecoming-checklist]]). The raft goes in today: [[voyage/ogygia/raft]], [[decisions/leave-today]].

See [[crew/burials-and-cenotaphs]] and [[crew/_index]].`,
    links: ["ithaca/estate.md", "voyage/ogygia/raft.md", "crew/burials-and-cenotaphs.md", "crew/_index.md", "ithaca/island/harbour-of-phorcys.md", "ithaca/stores/cattle.md", "ithaca/homecoming-checklist.md", "decisions/leave-today.md"],
    fields: { mounds: 12, names: 600, blocked_on: "reaching Ithaca" },
  },
  {
    path: "crew/promises-to-the-dead.md",
    title: "Promises to the dead",
    type: "list",
    created: "2018-03-24",
    updated: "2026-07-12",
    status: "open",
    tags: ["promises", "rites", "acheron"],
    people: ["person:elpenor", "person:teiresias"],
    places: ["place:acheron", "place:aeaea", "place:ithaca"],
    summary: "What I promised at the pit and on the beaches. One kept, the rest waiting on a raft.",
    body: `Promises made to the dead, or on their behalf. A promise to a living man can be renegotiated. These cannot.

| Made | To | Promise | Standing |
|---|---|---|---|
| day 9 | the seventy-two | to call their names before we sailed | kept ([[voyage/day-10-ismarus-morning-after]]) |
| day 620 | [[crew/elpenor]] | burial with his armour, a barrow, his oar on it | kept, day 624 ([[oaths/promise-to-elpenor]]) |
| day 620 | the dead at the pit | a barren heifer, the best I have, burned at home on Ithaca | open ([[oaths/vow-to-the-dead]]) |
| day 620 | [[people/teiresias]] | a ram for him alone, the finest of my flocks | open |
| day 1095 | the thirty-one | to call their names, and did, alone | kept |
| day 1095 | all six hundred | a cenotaph per ship on Ithaca | open |
| day 1095 | all six hundred | that each family hears it from me | open |

## Elpenor's oar

He asked for it specifically: the oar he rowed with among his companions, planted on the mound, so that men to come would know. It was the simplest thing anyone asked of me on the whole voyage and the only one I have been able to finish. It stands on the headland on Aeaea: [[crew/barrow-on-aeaea]].

## The open ones

Every open line above requires me to be on Ithaca, alive, with the household restored enough to have a heifer and a ram to give. The forecast says that can still happen, late and alone: [[knowledge/teiresias-forecast]], [[studies/forecast-after-the-crossing]].

## Review

- Reviewed every year on day 620.
- Reviewed today, day 3652, because the raft is going in and some of these may be kept within the month.

See [[crew/cenotaph-plan]], [[crew/families-owed-news]] and [[crew/_index]].`,
    links: ["crew/elpenor.md", "people/teiresias.md", "crew/barrow-on-aeaea.md", "knowledge/teiresias-forecast.md", "crew/cenotaph-plan.md", "crew/families-owed-news.md", "crew/_index.md", "voyage/day-10-ismarus-morning-after.md", "oaths/promise-to-elpenor.md", "oaths/vow-to-the-dead.md", "studies/forecast-after-the-crossing.md"],
    fields: { promises: 7, kept: 3, open: 4 },
  },
  {
    path: "crew/open-questions.md",
    title: "What the crew records still ask",
    type: "list",
    created: "2019-07-20",
    updated: "2026-07-12",
    status: "open",
    tags: ["review", "fleet", "questions"],
    places: ["place:ogygia"],
    summary: "Every open question left in the crew records, gathered in one place so that none of them is lost in a ship record nobody reopens.",
    body: `Collected on Ogygia from every crew record. Some of these can be answered on Ithaca ([[ithaca/questions-on-landing]]); some can only be answered by men who are not available.

## Answerable on Ithaca

- [ ] Whose households paid for ship 3's spare oars. [[crew/ships/ship-03]]
- [ ] Which households under Mount Neriton lost more than one man from ship 5. [[crew/ships/ship-05]]
- [ ] What Antiphus's father, [[people/aegyptius]], has heard, and what he has decided. [[crew/antiphus]]
- [ ] Where Same, Zacynthus and the mainland want their mounds. [[crew/cenotaph-plan]]

## Answerable by nobody

- [ ] Whether the crew would have left the bag alone if they had known. [[crew/aeolia-bag]] [[decisions/accept-the-bag-of-winds]]
- [ ] Whether the six at the strait should have been told. [[decisions/scylla-or-charybdis]] [[decisions/what-to-tell-the-crew]]
- [ ] Who argued against the cattle on day 1077 and lost. [[crew/oath-signatories]]
- [ ] Whether anyone swam for the mouth of the harbour. [[crew/ships/ship-02]]

## Answered

- [x] Why the count was wrong after Aeaea. No roll call on day 611. [[crew/roll-calls/day-620]]
- [x] Whether the oath held while there was food. It did. [[crew/thrinacia-provisions]]

## Not a question

Whether the crew ledger is right. It is. Six hundred, six hundred, one. [[crew/fleet-strength]]

See [[crew/_index]].`,
    links: ["crew/ships/ship-03.md", "crew/ships/ship-05.md", "crew/antiphus.md", "crew/cenotaph-plan.md", "crew/aeolia-bag.md", "decisions/scylla-or-charybdis.md", "crew/oath-signatories.md", "crew/ships/ship-02.md", "crew/roll-calls/day-620.md", "crew/thrinacia-provisions.md", "crew/fleet-strength.md", "crew/_index.md", "ithaca/questions-on-landing.md", "people/aegyptius.md", "decisions/accept-the-bag-of-winds.md", "decisions/what-to-tell-the-crew.md"],
    fields: { open: 8, answered: 2 },
  },
];
