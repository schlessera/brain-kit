// Library domain: voyage. See ../README.md and ./types.ts.
//
// The passage from Troy to Ogygia as Odysseus logged it: one leg record per
// stage (ships and crew at the start and end of each, closing on the crew
// ledger) and the ship's-log entries kept on the days that mattered. Crew
// counts never include Odysseus himself. The last leg is planned, not sailed.

import type { LibraryDocument } from "./types.js";

export const voyageDocuments: LibraryDocument[] = [
  // ---------------------------------------------------------------- legs
  {
    path: "voyage/legs/troy-departure.md",
    title: "Leg 1 -- Troy to the Thracian coast",
    type: "leg",
    created: "2016-07-15",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "fleet"],
    people: [],
    places: ["place:troy", "place:ismarus"],
    summary: "Twelve ships and six hundred men off the beach at Troy on day 3, bound north-west along the Thracian coast with a fair wind.",
    body: `Days 3 to 9. Six days elapsed.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 600 | 600 |
| Lost | -- | 0 |

## Weather and wind

Fair and steady from the south-east the first three days, then light airs. Rowed the last stretch into the coast of the Cicones.

## What was decided

To sail at once rather than wait for the other kings. Fifty men to a ship, my own ship numbered first. The plunder of Troy was shared out on the beach before loading, so no ship carried another's share and no crew had a quarrel to bring aboard.

Turned north for Thrace rather than straight across for home. The reason written down at the time was water and provisions. The reason not written down was that the fleet wanted more than Troy had given it.

## Losses

None.

## What the record still asks

- [ ] Whether the turn north was ever necessary. The stores were adequate for a direct crossing.
- [ ] Whether leaving before the other kings, without their counsel, cost anything that was not counted.

Log: [[voyage/day-3-departure]]. Roll call: [[crew/roll-calls/day-3]]. Shares: [[crew/shares-owed]]. First landfall: [[decisions/raid-ismarus]]. Next leg: [[voyage/legs/ismarus]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-3-departure.md", "voyage/legs/ismarus.md", "voyage/_index.md", "crew/roll-calls/day-3.md", "crew/shares-owed.md", "decisions/raid-ismarus.md"],
    fields: { day: 3, ships: 12, crewAboard: 600, lost: 0, shipsAtEnd: 12, crewAtEnd: 600, daysSpent: 6 },
  },
  {
    path: "voyage/legs/ismarus.md",
    title: "Leg 2 -- Ismarus and the Cicones",
    type: "leg",
    created: "2016-07-21",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "losses"],
    places: ["place:ismarus"],
    summary: "A raid on Ismarus that should have taken a morning. Six men lost from every ship because they would not leave the wine.",
    body: `Days 9 to 21. Twelve days elapsed, most of them spent getting away.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 600 | 528 |
| Lost | -- | 72 |

## Weather and wind

Calm on the day of the raid. A north wind afterwards, rising, which carried the fleet south and was the first sign of what Malea would be.

## What was decided

To take the town, divide the goods and leave the same day. I gave the order to leave. The men would not ([[decisions/stay-the-night-at-ismarus]]); they had found the wine and the cattle on the shore and slaughtered sheep into the evening. The Cicones fetched their neighbours from inland, and the fighting went on until the sun turned.

[[people/maron]], priest of Apollo, was spared ([[decisions/spare-maron]]) with his wife and household, because he lived in the god's grove. He gave seven talents of worked gold, a mixing bowl of solid silver and twelve jars of sweet unmixed wine. One of those jars went into the cave of the Cyclopes. Nothing on this voyage has stayed in one leg.

## Losses

Seventy-two. Six from each ship, exactly: [[crew/losses/ismarus]]. Each name was called three times from the shore before we put out, as is owed.

## What the record still asks

- [ ] An order that is given and not obeyed is not an order. What would have made it one?
- [ ] Whether Maron's wine counts as a gift or as payment.

Logs: [[voyage/day-9-ismarus]], [[voyage/day-10-ismarus-morning-after]]. Crew: [[crew/_index]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-9-ismarus.md", "voyage/day-10-ismarus-morning-after.md", "crew/_index.md", "voyage/_index.md", "voyage/legs/cape-malea.md", "decisions/stay-the-night-at-ismarus.md", "people/maron.md", "decisions/spare-maron.md", "crew/losses/ismarus.md"],
    fields: { day: 9, ships: 12, crewAboard: 600, lost: 72, shipsAtEnd: 12, crewAtEnd: 528, daysSpent: 12 },
  },
  {
    path: "voyage/legs/cape-malea.md",
    title: "Leg 3 -- Round Malea, and off the chart",
    type: "leg",
    created: "2016-08-02",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "weather"],
    places: ["place:malea", "place:lotus"],
    summary: "Rounding Cape Malea with Ithaca three days off, the north wind took the fleet and drove it nine days south and west.",
    body: `Days 21 to 30. Nine days elapsed, every one of them under a wind we did not choose.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 528 | 528 |
| Lost | -- | 0 |

## Weather and wind

North wind ([[knowledge/boreas]]), then a gale out of the north, with the current against the cape. Sails torn on the second day; we lowered them and rowed for a lee shore, lay two days and two nights in it, then put out again. Off Malea the wind and the current together drove us past Cythera and out of all known water.

## What was decided

To ride it rather than fight it. Twelve ships trying to claw back round a cape in a gale would have been twelve wrecks. The masts were stepped again on the third morning and the fleet ran before the wind in company.

## Losses

None. That is the one achievement of this leg and it is worth recording.

## What the record still asks

- [ ] This was the closest to home the fleet ever came. Three days, with a fair wind.
- [ ] Nobody has ever established where the ninth day put us. The lotus coast was a landfall, not a position.

Logs: [[voyage/day-21-cape-malea]], [[voyage/day-25-driven-south]], [[voyage/day-29-ninth-day]]. Omen: [[omens/day-21-malea-wind]]. The ship that lost her mast step: [[crew/ships/ship-06]]. Next: [[voyage/legs/lotus-eaters]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-21-cape-malea.md", "voyage/day-25-driven-south.md", "voyage/day-29-ninth-day.md", "voyage/legs/lotus-eaters.md", "voyage/_index.md", "knowledge/boreas.md", "omens/day-21-malea-wind.md", "crew/ships/ship-06.md"],
    fields: { day: 21, ships: 12, crewAboard: 528, lost: 0, shipsAtEnd: 12, crewAtEnd: 528, daysSpent: 9 },
  },
  {
    path: "voyage/legs/lotus-eaters.md",
    title: "Leg 4 -- The land of the Lotus-eaters",
    type: "leg",
    created: "2016-08-11",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "crew"],
    places: ["place:lotus", "place:cyclopes"],
    summary: "Watering on the lotus coast; three men ate the fruit and had to be carried back to the ships bound. Then a long passage the log barely keeps.",
    body: `Days 30 to 96. Sixty-six days elapsed: one ashore, the rest at sea or beached on coasts nobody named.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 528 | 528 |
| Lost | -- | 0 |

## Weather and wind

Settled after the storm. Light westerlies and long calms on the passage north.

## What was decided

Three men ([[crew/lotus-eaters]]) were sent inland to learn who lived there. The people they met were not hostile. They gave them the lotus ([[knowledge/lotus]]), and the three men no longer wanted to come back, or to remember why they had come. I had them dragged to the ships, weeping, and tied under the benches. Then the order to everyone: nobody else eats, and we leave now.

It was the right order: [[decisions/drag-back-the-lotus-eaters]]. It was not a kind one. The three recovered within days and none of them thanked me.

## Losses

None. Three men nearly, which the ledger does not record and should.

## What the record still asks

- [ ] What does a crew owe a man who wants to stay? This came back later, on Aeaea, and again here on Ogygia, about me.
- [ ] Sixty days of the passage north have three lines in the log between them.

Logs: [[voyage/day-30-lotus-eaters]], [[voyage/day-31-leaving-the-lotus]]. Next: [[voyage/legs/cyclopes]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-30-lotus-eaters.md", "voyage/day-31-leaving-the-lotus.md", "voyage/legs/cyclopes.md", "voyage/_index.md", "crew/lotus-eaters.md", "knowledge/lotus.md", "decisions/drag-back-the-lotus-eaters.md"],
    fields: { day: 30, ships: 12, crewAboard: 528, lost: 0, shipsAtEnd: 12, crewAtEnd: 528, daysSpent: 66 },
  },
  {
    path: "voyage/legs/cyclopes.md",
    title: "Leg 5 -- The land of the Cyclopes",
    type: "leg",
    created: "2016-10-16",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "losses", "poseidon"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes", "place:aeolia"],
    summary: "Twelve men into a cave that was not empty; six eaten, the rest out under the sheep, and a name shouted from the stern that has cost every year since.",
    body: `Days 96 to 132. Four days at the Cyclopes, then thirty-three days on to Aeolia.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 528 | 522 |
| Lost | -- | 6, all from ship 1 |

## Weather and wind

Fog on the night of landfall, then fair. A good breeze off the land on the morning of the escape, which is the only reason the boulders missed.

## What was decided

The eleven ships stayed at the goat island. I took my own ship's crew across, and twelve men up to the cave, to see who lived there and whether they would give gifts to strangers. The crew wanted to take cheese and lambs and go. I wanted to meet the owner. That was the first decision of this leg and the worst: [[decisions/wait-for-polyphemus]].

The second was the name. I gave it as Nobody ([[decisions/nobody-as-the-name]]), which held. The third was to shout my real name from the stern, which undid the second: [[decisions/name-at-the-stern]], against my own written rule in [[notes/do-not-give-my-name]].

## Losses

Six from ship 1, two at a time, over two days: [[crew/losses/cyclopes]]. [[crew/antiphus]] was the last.

## What the record still asks

- [ ] Whether [[people/polyphemus]]'s prayer to his father is the whole of [[people/poseidon]]'s grievance, or only its start.
- [ ] Why ship 1 alone paid for a visit only its captain wanted.

Logs: [[voyage/day-96-goat-island]], [[voyage/day-97-the-cave]], [[voyage/day-98-the-stake]], [[voyage/day-99-escape]]. Part of [[voyage/_index]].`,
    links: ["decisions/name-at-the-stern.md", "notes/do-not-give-my-name.md", "people/polyphemus.md", "people/poseidon.md", "voyage/day-96-goat-island.md", "voyage/day-97-the-cave.md", "voyage/day-98-the-stake.md", "voyage/day-99-escape.md", "voyage/_index.md", "decisions/wait-for-polyphemus.md", "decisions/nobody-as-the-name.md", "crew/losses/cyclopes.md", "crew/antiphus.md"],
    fields: { day: 96, ships: 12, crewAboard: 528, lost: 6, shipsAtEnd: 12, crewAtEnd: 522, daysSpent: 36 },
  },
  {
    path: "voyage/legs/aeolia.md",
    title: "Leg 6 -- Aeolia, and the bag",
    type: "leg",
    created: "2016-11-21",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "winds"],
    places: ["place:aeolia"],
    summary: "Guests of Aeolus on his floating island; sent off with every adverse wind tied in an ox-hide bag and only the west wind left loose.",
    body: `Days 132 to 162. Arrived day 132; a month as [[people/aeolus]]'s guest; sailed day 162.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 522 | 522 |
| Lost | -- | 0 |

## Weather and wind

Whatever Aeolus allowed. He keeps the winds; that is his office from Zeus.

## What was decided

Aeolus asked for the whole account of Troy and the return, and heard it. When I asked for passage he gave it: the winds that could hinder us bound in a bag of ox-hide, closed with a silver cord, stowed in my own ship. The west wind ([[knowledge/zephyrus]]) he left free to blow us home.

I told nobody what was in the bag. I did not think to. That omission is the decision of this leg ([[decisions/accept-the-bag-of-winds]]), though it was not made on purpose.

## Losses

None here.

## What the record still asks

- [ ] Whether a month of being listened to made me careless about the one thing I did not say.
- [ ] Whether telling the crew would have changed anything, given what they believed was in it.

The bag: [[crew/aeolia-bag]]. Logs: [[voyage/day-132-aeolia-arrival]], [[voyage/day-162-aeolia-departure]]. Next: [[voyage/legs/ithaca-in-sight]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-132-aeolia-arrival.md", "voyage/day-162-aeolia-departure.md", "voyage/legs/ithaca-in-sight.md", "voyage/_index.md", "people/aeolus.md", "knowledge/zephyrus.md", "decisions/accept-the-bag-of-winds.md", "crew/aeolia-bag.md"],
    fields: { day: 132, ships: 12, crewAboard: 522, lost: 0, shipsAtEnd: 12, crewAtEnd: 522, daysSpent: 30 },
  },
  {
    path: "voyage/legs/ithaca-in-sight.md",
    title: "Leg 7 -- Ithaca in sight, and the bag opened",
    type: "leg",
    created: "2016-12-21",
    updated: "2026-07-12",
    status: "closed",
    tags: ["voyage", "leg", "winds", "ithaca"],
    people: ["person:penelope"],
    places: ["place:aeolia", "place:ithaca"],
    summary: "Nine days of fair wind to within sight of the fires on Ithaca; I slept, the crew opened the bag, and every wind in it carried the fleet back to Aeolia.",
    body: `Days 162 to 205. Nine days to within sight of Ithaca, a day blown back, then thirty-three days rowing without a wind.

| | Start | End |
|---|---|---|
| Ships | 12 | 12 |
| Crew aboard | 522 | 522 |
| Lost | -- | 0 |

## Weather and wind

West wind, steady, nine days and nights. Then, at once, all of them.

## What was decided

I held the sheet myself for nine days so no one else would have to ([[decisions/keep-the-helm-nine-days]]), and on the tenth, with the island close enough to see men tending fires, I slept. The crew decided the bag held gold that Aeolus had given me and not them. They opened it.

On day 172 we were back at Aeolia. Aeolus would not hear me a second time ([[decisions/return-to-aeolus]]). A man the gods so plainly hate, he said, is not to be helped. We left under oars.

## Losses

No men. The return, as it stood that day.

## What the record still asks

- [ ] What it would have cost to sleep one hour earlier, in open water, with the bag explained.
- [ ] [[people/penelope]] does not know how close this was. Whether to tell her is not a question for the log.

Journal: [[journal/day-172]]. Logs: [[voyage/day-162-aeolia-departure]], [[voyage/day-167-west-wind-holding]], [[voyage/day-171-ithaca-in-sight]], [[voyage/day-172-aeolus-refuses]]. Part of [[voyage/_index]], serving [[goals/return-to-ithaca]].`,
    links: ["people/penelope.md", "voyage/day-162-aeolia-departure.md", "voyage/day-167-west-wind-holding.md", "voyage/day-171-ithaca-in-sight.md", "voyage/day-172-aeolus-refuses.md", "voyage/_index.md", "goals/return-to-ithaca.md", "decisions/keep-the-helm-nine-days.md", "decisions/return-to-aeolus.md", "journal/day-172.md"],
    fields: { day: 162, ships: 12, crewAboard: 522, lost: 0, shipsAtEnd: 12, crewAtEnd: 522, daysSpent: 43 },
  },
  {
    path: "voyage/legs/laestrygonians.md",
    title: "Leg 8 -- The Laestrygonian harbour",
    type: "leg",
    created: "2017-02-02",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "losses"],
    places: ["place:laestrygonians", "place:aeaea"],
    summary: "Eleven ships moored inside a harbour with one narrow mouth; mine outside. The eleven were sunk with stones from the cliffs, and 484 men with them.",
    body: `Days 205 to 246. One day in the harbour, forty-one on the way to Aeaea.

| | Start | End |
|---|---|---|
| Ships | 12 | 1 |
| Crew aboard | 522 | 38 |
| Lost | -- | 484 |

## Weather and wind

Flat calm inside the harbour, which is why the others went in. Light airs after; we rowed most of the way south.

## What was decided

The harbour was enclosed by sheer rock on both sides with a narrow entrance. The captains of the eleven took their ships in and moored close together. I tied mine to a rock outside the mouth ([[decisions/moor-outside-the-harbour]]). I did not order them to stay out. I did not think I needed to.

Three men went up the road to learn who ruled there. Two came back running. [[people/antiphates]] and his people came down to the cliffs and threw rocks the size of a man onto the ships, and speared the crews like fish.

I cut my own cable with my sword ([[decisions/cut-the-cable]]) and told the crew to row for their lives. They did.

## Losses

Eleven ships, each with forty-four men aboard since Ismarus: 484 ([[crew/losses/laestrygonians]]). Ship 1 escaped with 38, its fifty less six at Ismarus and six in the cave.

## What the record still asks

- [ ] Whether a captain who moors safely and says nothing has made a decision for the others.
- [ ] The scout who did not come back was from the eleven and is counted there.

Logs: [[voyage/day-205-laestrygonian-harbour]], [[voyage/day-206-one-ship]]. Crew: [[crew/_index]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-205-laestrygonian-harbour.md", "voyage/day-206-one-ship.md", "crew/_index.md", "voyage/_index.md", "decisions/moor-outside-the-harbour.md", "people/antiphates.md", "decisions/cut-the-cable.md", "crew/losses/laestrygonians.md"],
    fields: { day: 205, ships: 12, crewAboard: 522, lost: 484, shipsAtEnd: 1, crewAtEnd: 38, daysSpent: 41 },
  },
  {
    path: "voyage/legs/aeaea-first-stay.md",
    title: "Leg 9 -- Aeaea, the first stay",
    type: "leg",
    created: "2017-03-15",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "aeaea"],
    people: ["person:circe", "person:eurylochus", "person:elpenor"],
    places: ["place:aeaea"],
    summary: "A year on Circe's island: the men turned to swine and restored, a winter of rest, and the crew asking to go home before I did.",
    body: `Days 246 to 611. Three hundred and sixty-five days: one full year.

| | Start | End |
|---|---|---|
| Ships | 1 | 1 |
| Crew aboard | 38 | 37 |
| Lost | -- | 1 |

## Weather and wind

Four seasons of it, all from the shore. The ship was hauled up and the tackle stowed in caves.

## What was decided

Twenty-three of the crew went with [[crew/eurylochus]] to the hall in the woods; fifteen stayed with me at the ship ([[crew/aeaea-scouting-party]]). Twenty-two went in; Eurylochus alone stayed outside, and came back to say the rest had vanished. They had been turned to swine. [[people/hermes]] met me on the path and gave me [[knowledge/moly]] against her drugs. [[people/circe]] restored the men and offered us her house.

Then the harder decision: to stay ([[decisions/stay-the-year]]). It was not a decision so much as the absence of one, renewed every morning for a year. At the end of it the crew came to me and asked whether I had forgotten Ithaca. I had not. I had stopped writing it down.

## Losses

[[crew/elpenor]], on the morning we left. He slept on the roof for the cool, woke at the noise of departure, forgot the ladder and fell. Nobody saw it until after we sailed.

## What the record still asks

- [ ] A year with no entry under the goal.
- [ ] Elpenor was left unburied because nobody counted heads at the shore.

Logs: [[voyage/day-246-aeaea-arrival]], [[voyage/day-247-the-swine]], [[voyage/day-248-moly]], [[voyage/day-345-midsummer]], [[voyage/day-437-equinox]], [[voyage/day-528-midwinter]], [[voyage/day-608-the-crew-ask]], [[voyage/day-611-elpenor]]. Part of [[voyage/_index]].`,
    links: ["crew/eurylochus.md", "people/circe.md", "crew/elpenor.md", "voyage/day-246-aeaea-arrival.md", "voyage/day-247-the-swine.md", "voyage/day-248-moly.md", "voyage/day-345-midsummer.md", "voyage/day-437-equinox.md", "voyage/day-528-midwinter.md", "voyage/day-608-the-crew-ask.md", "voyage/day-611-elpenor.md", "voyage/_index.md", "crew/aeaea-scouting-party.md", "people/hermes.md", "knowledge/moly.md", "decisions/stay-the-year.md"],
    fields: { day: 246, ships: 1, crewAboard: 38, lost: 1, shipsAtEnd: 1, crewAtEnd: 37, daysSpent: 365 },
  },
  {
    path: "voyage/legs/house-of-the-dead.md",
    title: "Leg 10 -- To the house of the dead",
    type: "leg",
    created: "2018-03-15",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "forecast"],
    people: ["person:teiresias", "person:elpenor"],
    places: ["place:aeaea", "place:acheron"],
    summary: "Sent by Circe to the edge of the world to ask Teiresias the way home. He gave the forecast. My mother was there, which nobody had told me.",
    body: `Days 611 to 623. Twelve days, there and back.

| | Start | End |
|---|---|---|
| Ships | 1 | 1 |
| Crew aboard | 37 | 37 |
| Lost | -- | 0 |

## Weather and wind

North wind, as Circe said it would be, all the way to the stream of Ocean. We did not row.

## What was decided

Circe would not let us go home without it: first the dead, then Teiresias, then the route. [[crew/perimedes]] and [[crew/eurylochus]] held the victims. I dug the pit a cubit each way, poured the offerings, and sat with my sword drawn to keep the others from the blood until the seer had drunk, as in [[knowledge/rites-for-the-dead]].

[[people/teiresias]] gave the forecast: [[knowledge/teiresias-forecast]]. Then the shade of Elpenor, asking to be buried. Then my mother, [[people/anticleia]], who had died of grief while I was away. Three times I tried to hold her.

[[people/agamemnon]] told me how he died at his own table. Achilles asked after his son. Ajax would not speak to me at all, over the armour.

## Losses

None aboard. One learned of.

## What the record still asks

- [ ] Whether anyone at home has been told what I learned here about my mother.
- [ ] The forecast has one condition. Every later leg should be read against it.

Logs: [[voyage/day-620-acheron]], [[voyage/day-622-leaving-the-dead]]. Part of [[voyage/_index]].`,
    links: ["crew/eurylochus.md", "people/teiresias.md", "knowledge/teiresias-forecast.md", "voyage/day-620-acheron.md", "voyage/day-622-leaving-the-dead.md", "voyage/_index.md", "crew/perimedes.md", "knowledge/rites-for-the-dead.md", "people/anticleia.md", "people/agamemnon.md"],
    fields: { day: 611, ships: 1, crewAboard: 37, lost: 0, shipsAtEnd: 1, crewAtEnd: 37, daysSpent: 12 },
  },
  {
    path: "voyage/legs/aeaea-return.md",
    title: "Leg 11 -- Aeaea, the second stay",
    type: "leg",
    created: "2018-03-27",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "aeaea"],
    people: ["person:circe", "person:elpenor"],
    places: ["place:aeaea"],
    summary: "Back to bury Elpenor, then waiting out the seasons on Aeaea until Circe would give the route. She gave it on day 1038.",
    body: `Days 623 to 1039. Four hundred and sixteen days.

| | Start | End |
|---|---|---|
| Ships | 1 | 1 |
| Crew aboard | 37 | 37 |
| Lost | -- | 0 |

## Weather and wind

The usual run of seasons. The ship was not launched again until the last week.

## What was decided

First, to keep the promise to Elpenor's shade: [[oaths/promise-to-elpenor]]. On day 624 we burned him with his armour, raised a barrow on the headland, and set his oar upright on top of it, the oar he had pulled while alive ([[crew/barrow-on-aeaea]]).

Then, to wait: [[decisions/wait-out-the-seasons]]. The reasons in the log are the winter, the condition of the hull, and Circe's advice. All three were real. None of them takes four hundred days.

On day 1038 she took me aside and gave the route: the Sirens, then the choice of two ways, the [[knowledge/wandering-rocks]] or the strait, and then Thrinacia. She was specific about the strait and very specific about the cattle.

## Losses

None. The quietest leg of the whole voyage, and the longest.

## What the record still asks

- [ ] Whether Circe delayed the route or I delayed asking for it.
- [ ] Two years on Aeaea, all told. Ithaca could have been reached twice over.

Logs: [[voyage/day-623-aeaea-return]], [[voyage/day-624-elpenor-buried]], [[voyage/day-800-season-closing]], [[voyage/day-892-midwinter]], [[voyage/day-1038-circes-route]]. Contact: [[people/circe]]. Part of [[voyage/_index]].`,
    links: ["voyage/day-623-aeaea-return.md", "voyage/day-624-elpenor-buried.md", "voyage/day-800-season-closing.md", "voyage/day-892-midwinter.md", "voyage/day-1038-circes-route.md", "people/circe.md", "voyage/_index.md", "oaths/promise-to-elpenor.md", "crew/barrow-on-aeaea.md", "decisions/wait-out-the-seasons.md", "knowledge/wandering-rocks.md"],
    fields: { day: 623, ships: 1, crewAboard: 37, lost: 0, shipsAtEnd: 1, crewAtEnd: 37, daysSpent: 416 },
  },
  {
    path: "voyage/legs/sirens.md",
    title: "Leg 12 -- Past the Sirens",
    type: "leg",
    created: "2019-05-17",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "hazard"],
    people: ["person:circe"],
    places: ["place:aeaea", "place:sirens"],
    summary: "Out of Aeaea with Circe's wind, wax in the crew's ears, and myself tied to the mast, exactly as she said.",
    body: `Days 1039 to 1043. Four days.

| | Start | End |
|---|---|---|
| Ships | 1 | 1 |
| Crew aboard | 37 | 37 |
| Lost | -- | 0 |

## Weather and wind

A following wind from Aeaea, sent by Circe. It fell to a dead calm ([[omens/day-1041-calm]]) as we came up on the island, and we took the sail in and rowed.

## What was decided

Everything was decided in advance, which is why it worked. I cut a wheel of wax into pieces, softened it in my hands and in the sun, and sealed each man's ears myself ([[crew/sirens-wax]]). They tied me upright to the mast-step and were told: if I order you to untie me, add more rope ([[oaths/sirens-binding-order]]).

I did order it. [[crew/perimedes]] and Eurylochus added more rope.

The method is filed in [[knowledge/sirens]].

## Losses

None.

## What the record still asks

- [ ] This is the only leg where a plan written in advance was followed to the letter. It should be the pattern, and it was not.
- [ ] Thirty-seven rowed past, and every one of them was dead within forty-three days. Was the luck at the Sirens spent on the wrong water?

Logs: [[voyage/day-1039-leaving-aeaea]], [[voyage/day-1040-eve-of-the-sirens]], [[voyage/day-1041-sirens]]. Part of [[voyage/_index]].`,
    links: ["knowledge/sirens.md", "voyage/day-1039-leaving-aeaea.md", "voyage/day-1040-eve-of-the-sirens.md", "voyage/day-1041-sirens.md", "voyage/_index.md", "omens/day-1041-calm.md", "crew/sirens-wax.md", "oaths/sirens-binding-order.md", "crew/perimedes.md"],
    fields: { day: 1039, ships: 1, crewAboard: 37, lost: 0, shipsAtEnd: 1, crewAtEnd: 37, daysSpent: 4 },
  },
  {
    path: "voyage/legs/the-strait.md",
    title: "Leg 13 -- The strait",
    type: "leg",
    created: "2019-05-21",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "hazard", "losses"],
    people: ["person:circe"],
    places: ["place:scylla", "place:charybdis", "place:messina"],
    summary: "Through the strait on Scylla's side, as Circe advised. Six taken from the deck; Charybdis avoided.",
    body: `Day 1043 into day 1044. One passage.

| | Start | End |
|---|---|---|
| Ships | 1 | 1 |
| Crew aboard | 37 | 31 |
| Lost | -- | 6 |

## Weather and wind

Little wind; spray and noise from Charybdis on the left hand the whole way through. Rowing.

## What was decided

The decision is filed in full: [[decisions/scylla-or-charybdis]]. Circe said there was no fighting Scylla, and that stopping to try would cost six more. I armed myself anyway ([[decisions/arm-against-scylla]]) and stood on the foredeck with two spears, watching the wrong side, because Charybdis was the one we could see.

I did not tell the crew about Scylla ([[decisions/what-to-tell-the-crew]]). They would have stopped rowing to hide.

## Losses

Six, from the benches, one to each head: [[crew/scylla-six]]. They called me by name as they went up.

## What the record still asks

- [ ] Whether the crew had a right to know, and what they would have chosen.
- [ ] Whether the armour helped anyone, or only me.

See [[knowledge/scylla]], [[knowledge/charybdis]] and [[studies/strait-passages-compared]]. Log: [[voyage/day-1043-strait]]. Next: [[voyage/legs/thrinacia]]. Part of [[voyage/_index]].`,
    links: ["decisions/scylla-or-charybdis.md", "knowledge/scylla.md", "knowledge/charybdis.md", "voyage/day-1043-strait.md", "voyage/legs/thrinacia.md", "voyage/_index.md", "decisions/arm-against-scylla.md", "decisions/what-to-tell-the-crew.md", "crew/scylla-six.md", "studies/strait-passages-compared.md"],
    fields: { day: 1043, ships: 1, crewAboard: 37, lost: 6, shipsAtEnd: 1, crewAtEnd: 31, daysSpent: 1 },
  },
  {
    path: "voyage/legs/thrinacia.md",
    title: "Leg 14 -- Thrinacia",
    type: "leg",
    created: "2019-05-22",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "oath", "helios"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Both seers said avoid the island. The crew outvoted me on landing, swore the oath, waited thirty days for a wind, and then ate the cattle.",
    body: `Days 1044 to 1084. Forty days.

| | Start | End |
|---|---|---|
| Ships | 1 | 1 |
| Crew aboard | 31 | 31 |
| Lost | -- | 0 on the island |

## Weather and wind

South and east, without a break, for thirty days. No wind for home and none for anywhere else.

## What was decided

To land at all: [[decisions/land-on-thrinacia]]. I wanted to row past. [[crew/eurylochus]] said the men were spent and would eat on the beach and sail in the morning, and the crew agreed with him. I made every man swear first: [[oaths/helios]], sworn by all of [[crew/oath-signatories]].

To ration: [[crew/thrinacia-provisions]]. When the stores ran out the men fished and snared birds. I went inland to pray, and slept.

On day 1077, while I slept, Eurylochus argued that starving was the worst death and that a temple to Helios at home would settle the debt. They drove off the best of the cattle ([[knowledge/thrinacia-cattle]]). The full record: [[decisions/cattle-of-helios]].

## Losses

None on the island. All of them for it.

## What the record still asks

- [ ] Whether a man asleep can be said to have lost a vote.
- [ ] [[knowledge/teiresias-forecast]] named this as the one condition. It was known to everyone aboard.

Logs: [[voyage/day-1044-thrinacia-landfall]], [[voyage/day-1050-wind-still-south]], [[voyage/day-1062-stores-out]], [[voyage/day-1077-the-cattle]], [[voyage/day-1083-sixth-day]]. Part of [[voyage/_index]].`,
    links: ["crew/eurylochus.md", "oaths/helios.md", "decisions/cattle-of-helios.md", "knowledge/teiresias-forecast.md", "voyage/day-1044-thrinacia-landfall.md", "voyage/day-1050-wind-still-south.md", "voyage/day-1062-stores-out.md", "voyage/day-1077-the-cattle.md", "voyage/day-1083-sixth-day.md", "voyage/_index.md", "decisions/land-on-thrinacia.md", "crew/oath-signatories.md", "crew/thrinacia-provisions.md", "knowledge/thrinacia-cattle.md"],
    fields: { day: 1044, ships: 1, crewAboard: 31, lost: 0, shipsAtEnd: 1, crewAtEnd: 31, daysSpent: 40 },
  },
  {
    path: "voyage/legs/the-wreck-and-charybdis.md",
    title: "Leg 15 -- The wreck, and Charybdis again",
    type: "leg",
    created: "2019-07-01",
    updated: "2026-07-01",
    status: "closed",
    tags: ["voyage", "leg", "losses", "wreck"],
    places: ["place:thrinacia", "place:charybdis"],
    summary: "Out of sight of land, Zeus's storm took the mast and then the ship. All thirty-one lost. A night later the wreckage carried me back into Charybdis.",
    body: `Days 1084 to 1085.

| | Start | End |
|---|---|---|
| Ships | 1 | 0 |
| Crew aboard | 31 | 0 |
| Lost | -- | 31 |

## Weather and wind

A west wind out of a clear sky, the moment the island dropped astern. Then cloud on the water, the forestays parted together, and the mast came down across the helmsman's head ([[crew/helmsmen]]). Then the bolt: [[omens/day-1084-thunder]]. Then a south wind through the night.

## What was decided

Nothing by me, until the end. When the ship broke up I lashed the mast to the keel with the backstay and sat on them.

The south wind carried me back up to the strait by morning, and Charybdis was drawing in. I caught the fig tree on the rock above her ([[decisions/hold-the-fig-tree]]) and hung there, with nowhere to put my feet, until she gave the timbers back. Then I let go and dropped onto them, and paddled with my hands.

## Losses

Thirty-one. Every man aboard: [[crew/losses/thrinacia]]. The ledger closed here: [[crew/_index]].

## What the record still asks

- [ ] Nothing that can be answered. The dead cannot be assigned work.

See [[knowledge/charybdis]]. Logs: [[voyage/day-1084-the-storm]], [[voyage/day-1085-the-fig-tree]]. Part of [[voyage/_index]].`,
    links: ["crew/_index.md", "knowledge/charybdis.md", "voyage/day-1084-the-storm.md", "voyage/day-1085-the-fig-tree.md", "voyage/_index.md", "crew/helmsmen.md", "omens/day-1084-thunder.md", "decisions/hold-the-fig-tree.md", "crew/losses/thrinacia.md"],
    fields: { day: 1084, ships: 1, crewAboard: 31, lost: 31, shipsAtEnd: 0, crewAtEnd: 0, daysSpent: 1 },
  },
  {
    path: "voyage/legs/drift-to-ogygia.md",
    title: "Leg 16 -- Adrift to Ogygia",
    type: "leg",
    created: "2019-07-02",
    updated: "2026-07-12",
    status: "closed",
    tags: ["voyage", "leg", "adrift", "ogygia"],
    people: ["person:calypso"],
    places: ["place:charybdis", "place:ogygia"],
    summary: "Nine days adrift on a mast and a keel, and on the tenth night a beach. Calypso's island. The stay has lasted seven years.",
    body: `Days 1085 to 1095. Nine days adrift, ten nights.

| | Start | End |
|---|---|---|
| Ships | 0 | 0 |
| Crew aboard | 0 | 0 |
| Lost | -- | 0 |

## Weather and wind

Light, variable. The current mattered more than the wind. The sun overhead, then rain on the fourth day, which I drank from the timber ([[knowledge/fevers]]).

## What was decided

To keep my hands on the wood. There was nothing else to decide.

On the tenth night the gods put me ashore on Ogygia ([[ogygia/island/day-1095-landfall]]). [[people/calypso]] took me in, fed me, and cared for me. That is the plain account and it should stay plain.

## Losses

None. There was no one left to lose.

## What the record still asks

- [ ] The log stops here for seven years. The record of the stay is under [[ogygia/_index]].
- [ ] The next leg is on a raft: [[voyage/ogygia/raft]]. It has not sailed.

Logs: [[voyage/day-1088-adrift]], [[voyage/day-1092-adrift]], [[voyage/day-1095-ogygia]]. Journal: [[journal/day-1090]], [[journal/day-1095]]. Next: [[voyage/legs/ogygia-to-scheria]]. Part of [[voyage/_index]].`,
    links: ["people/calypso.md", "ogygia/_index.md", "voyage/ogygia/raft.md", "voyage/day-1088-adrift.md", "voyage/day-1092-adrift.md", "voyage/day-1095-ogygia.md", "voyage/legs/ogygia-to-scheria.md", "voyage/_index.md", "knowledge/fevers.md", "ogygia/island/day-1095-landfall.md", "journal/day-1090.md", "journal/day-1095.md"],
    fields: { day: 1085, ships: 0, crewAboard: 0, lost: 0, shipsAtEnd: 0, crewAtEnd: 0, daysSpent: 10 },
  },
  {
    path: "voyage/legs/ogygia-to-scheria.md",
    title: "Leg 17 -- Ogygia to Scheria (planned)",
    type: "leg",
    created: "2026-07-12",
    updated: "2026-07-12",
    status: "planned",
    tags: ["voyage", "leg", "plan", "raft"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:scheria"],
    summary: "Planned, not sailed: launch today, seventeen days of open water east of north, landfall on Scheria on 29 July if the plan holds.",
    body: `**Planned. This leg has not happened.** Nothing below is a report.

| | Planned |
|---|---|
| Vessel | the raft, not one of the twelve |
| Aboard | myself |
| Launch | day 3652, 12 July |
| Open water | 17 days, about 632 km (788 km the whole way home) |
| Landfall | Scheria, 29 July |

## Route

Calypso's directions ([[ogygia/build/sailing-directions]]), written down as she gave them: keep the Great Bear on the left hand, and sail east of north. Watch the Pleiades and the late-setting Ploughman. Do not sleep at the steering oar.

## Stores

- [x] One skin of wine and one larger skin of water, about 18 litres, from Calypso: aboard
- [ ] The bag of bread, fifty-one loaves, and relishes: not yet aboard
- [ ] Water: two more jars, about 10 litres each, proposed. A shortfall for seventeen days, to review before launch ([[studies/water-ration]])
- [ ] A second skin of wine: not yet aboard

## Risks named in advance

- [ ] [[people/poseidon]] has not withdrawn the grievance. This is his water: [[studies/poseidon-risk]].
- [ ] A raft does not come about. A wrong wind is a wrong course.
- [ ] Scheria is a landfall on a plan, not a place I know. Who lives there has not been established.

## What the record still asks

Whether the raft will hold: [[voyage/ogygia/raft]] and [[voyage/ogygia/_index]]. Whether today is the day: [[decisions/leave-today]] and [[journal/day-3652]]. Part of [[voyage/_index]], serving [[goals/return-to-ithaca]].`,
    links: ["people/poseidon.md", "voyage/ogygia/raft.md", "voyage/ogygia/_index.md", "journal/day-3652.md", "voyage/_index.md", "goals/return-to-ithaca.md", "ogygia/build/sailing-directions.md", "studies/water-ration.md", "studies/poseidon-risk.md", "decisions/leave-today.md"],
    fields: { day: 3652, ships: 0, crewAboard: 0, lost: 0, plannedDays: 17, plannedLandfall: "2026-07-29", confidence: "planned" },
  },

  // ---------------------------------------------------------------- log
  {
    path: "voyage/day-3-departure.md",
    title: "Day 3 -- away from Troy",
    type: "log",
    created: "2016-07-15",
    updated: "2016-07-15",
    status: "filed",
    tags: ["log", "fleet"],
    places: ["place:troy"],
    summary: "Twelve ships off the beach at first light, fifty men to each. The plunder shared before loading.",
    body: `**Position:** off the beach below Troy, standing out.
**Wind:** south-east, moderate.
**Sea:** slight.
**Aboard:** 600 across 12 ships; 50 in ship 1 and myself.

The town is still burning behind us. We left on the third morning, which is earlier than most of the kings, and some of them said so.

Plunder shared on the sand by lot before anything went aboard. Every ship took water and grain for twenty days. The horses we did not take.

Order of sailing: ship 1 leads, the rest in two lines. Signal for close order is the raised oar.

Most of the men have not seen home in ten years. Neither have I. There is no reason this should take more than a season.

**Decision:** north-west along the Thracian coast for water before the crossing.

Roll call: [[crew/roll-calls/day-3]]. Shares: [[crew/shares-owed]]. Orders: [[crew/standing-orders]]. Leg: [[voyage/legs/troy-departure]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/troy-departure.md", "voyage/_index.md", "crew/roll-calls/day-3.md", "crew/shares-owed.md", "crew/standing-orders.md"],
    fields: { day: 3, place: "Troy", wind: "south-east", aboard: 600 },
  },
  {
    path: "voyage/day-9-ismarus.md",
    title: "Day 9 -- Ismarus",
    type: "log",
    created: "2016-07-21",
    updated: "2016-07-21",
    status: "filed",
    tags: ["log", "losses"],
    places: ["place:ismarus"],
    summary: "Took the town by mid-morning. Gave the order to leave by noon. Still on the beach at sunset, when the Cicones came back with their neighbours.",
    body: `**Position:** the beach below Ismarus, coast of the Cicones.
**Wind:** none to speak of.
**Sea:** calm.
**Aboard:** 600 at dawn. 528 at nightfall.

Landed at first light and took the town ([[decisions/raid-ismarus]]). The men were killed, the women and the goods divided so that nobody went short.

Order given at noon: back to the ships, now. Not obeyed ([[decisions/stay-the-night-at-ismarus]]). The crews had found the wine, and there were sheep and cattle on the shore. They sat down to it.

The Cicones who escaped went inland for the rest of their people, who fight from chariots and on foot, and there were more of them than there are leaves in spring. They came down in the afternoon. We held by the ships until the sun went over, and then we broke.

Six from each ship. I have counted twice: [[crew/losses/ismarus]].

[[people/maron]], priest of Apollo, and his household were spared. He gave the wine.

**Decision:** to sail tonight with what we have, before they come again.

Leg: [[voyage/legs/ismarus]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/ismarus.md", "voyage/_index.md", "decisions/raid-ismarus.md", "decisions/stay-the-night-at-ismarus.md", "crew/losses/ismarus.md", "people/maron.md"],
    fields: { day: 9, place: "Ismarus", wind: "calm", aboard: 528, lost: 72 },
  },
  {
    path: "voyage/day-10-ismarus-morning-after.md",
    title: "Day 10 -- the morning after Ismarus",
    type: "log",
    created: "2016-07-22",
    updated: "2016-07-22",
    status: "filed",
    tags: ["log", "losses", "crew"],
    places: ["place:ismarus"],
    summary: "Seventy-two names called three times each from the water before we pulled away. Nobody spoke at the oars.",
    body: `**Position:** standing off the Thracian coast, south of Ismarus.
**Wind:** north, freshening.
**Sea:** moderate and building.
**Aboard:** 528; 44 in ship 1 and myself.

Did not sail until each of the dead had been called three times by name from the ships. That is owed. It took most of an hour.

The count by ship is even: six from every one. That is not chance. It is what happens when every crew finds the same wine and every crew decides the same thing at the same time.

| | Embarked | Lost | Aboard |
|---|---|---|---|
| Each ship | 50 | 6 | 44 |
| Fleet | 600 | 72 | 528 |

[[people/maron]]'s twelve jars stowed in ship 1 ([[crew/ismarus-wine-ration]]). Wine so strong it is drunk one cup to twenty of water. Its smell fills the hold.

- [ ] Write down what an order to leave needs, besides being given. See [[crew/standing-orders]].

**Decision:** south, with the north wind, round Malea and home.

Leg: [[voyage/legs/ismarus]]. Roll call: [[crew/roll-calls/day-10]]. Journal: [[journal/day-10]]. Crew: [[crew/_index]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/ismarus.md", "crew/_index.md", "voyage/_index.md", "people/maron.md", "crew/ismarus-wine-ration.md", "crew/standing-orders.md", "crew/roll-calls/day-10.md", "journal/day-10.md"],
    fields: { day: 10, place: "off Ismarus", wind: "north", aboard: 528 },
  },
  {
    path: "voyage/day-21-cape-malea.md",
    title: "Day 21 -- Cape Malea",
    type: "log",
    created: "2016-08-02",
    updated: "2016-08-02",
    status: "filed",
    tags: ["log", "weather"],
    places: ["place:malea"],
    summary: "Rounding Malea, three days from Ithaca with a fair wind. The wind did not stay fair.",
    body: `**Position:** off Cape Malea, the south-eastern point of the Peloponnese.
**Wind:** north, then north gale.
**Sea:** rough, current setting hard to the west.
**Aboard:** 528.

Came down past the coast in good order. Malea in sight at noon. With an ordinary wind this is three days from home: up the western side, past Pylos, and the island would be under the bow by the evening of the third.

As we came level with the cape, the north wind ([[knowledge/boreas]]) and the current took us together. No ship could bring her head round. We are being set past Cythera, out to the south and west, away from every coast I know.

Masts are down for now. The ships are in sight of one another. Men bailing in turns ([[knowledge/bailing]]).

> Three days. Write it down so it cannot be argued later.

**Decision:** run before it in company. Do not try to claw back round the cape.

Omen: [[omens/day-21-malea-wind]]. Leg: [[voyage/legs/cape-malea]]. Part of [[voyage/_index]], serving [[goals/return-to-ithaca]].`,
    links: ["voyage/legs/cape-malea.md", "voyage/_index.md", "goals/return-to-ithaca.md", "knowledge/boreas.md", "knowledge/bailing.md", "omens/day-21-malea-wind.md"],
    fields: { day: 21, place: "Cape Malea", wind: "north gale", aboard: 528 },
  },
  {
    path: "voyage/day-25-driven-south.md",
    title: "Day 25 -- driven south",
    type: "log",
    created: "2016-08-06",
    updated: "2016-08-06",
    status: "filed",
    tags: ["log", "weather"],
    places: ["place:malea"],
    summary: "Fifth day of the gale. No land, no stars, twelve ships still in company, which is the only good line in this entry.",
    body: `**Position:** unknown. South and west of Malea, beyond Cythera, out of sight of land since the second day.
**Wind:** north, gale force, no change.
**Sea:** very rough.
**Aboard:** 528.

Fifth day. The sky has been closed every night, so there are no stars to steer by and nothing to steer for. The sun shows for an hour around noon.

Every ship still in sight at dawn. I count them each morning before anything else. Twelve.

Water rationed to half. Grain kept dry in two ships out of three. The men sleep at the oars in shifts and nobody complains, because complaining needs breath.

- [x] Count the ships at first light
- [x] Count the water
- [ ] Find a star

There is nothing to decide. The wind ([[knowledge/boreas]]) decides.

**Decision:** hold the course the wind gives. Keep company. Keep counting.

Count: [[crew/fleet-strength]]. Leg: [[voyage/legs/cape-malea]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/cape-malea.md", "voyage/_index.md", "knowledge/boreas.md", "crew/fleet-strength.md"],
    fields: { day: 25, place: "open sea south of Malea", wind: "north gale", aboard: 528 },
  },
  {
    path: "voyage/day-29-ninth-day.md",
    title: "Day 29 -- the ninth day",
    type: "log",
    created: "2016-08-10",
    updated: "2016-08-10",
    status: "filed",
    tags: ["log", "weather"],
    places: ["place:malea", "place:lotus"],
    summary: "Nine days before the wind. It eased at dusk, and there was a low coast to the south by the last light.",
    body: `**Position:** off an unknown low coast, far south and west. No name for it yet.
**Wind:** north, easing to moderate at dusk.
**Sea:** moderate, falling.
**Aboard:** 528.

Ninth day of the storm, by the count kept on the steering oar with a knife.

The wind began to drop in the afternoon. By evening the cloud broke and there was a coast to the south, flat and pale, with smoke in two places ([[knowledge/reading-a-coast]]). Not a coast anyone aboard has seen. The pilots argue about how far we have come and do not agree within a hundred miles.

Lay off for the night. Anchor stones over in sixteen fathoms.

Water nearly out. That decides tomorrow whatever else does not.

**Decision:** land at first light for water. A small party only ([[knowledge/watering-parties]]). Nobody goes inland further than the stream.

Leg: [[voyage/legs/cape-malea]]. Next: [[voyage/legs/lotus-eaters]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/cape-malea.md", "voyage/legs/lotus-eaters.md", "voyage/_index.md", "knowledge/reading-a-coast.md", "knowledge/watering-parties.md"],
    fields: { day: 29, place: "off the lotus coast", wind: "north, easing", aboard: 528 },
  },
  {
    path: "voyage/day-30-lotus-eaters.md",
    title: "Day 30 -- the lotus coast",
    type: "log",
    created: "2016-08-11",
    updated: "2016-08-11",
    status: "filed",
    tags: ["log", "crew"],
    places: ["place:lotus"],
    summary: "Watered and ate on the beach. Three men sent inland ate the lotus and would not come back; brought back by force and tied under the benches.",
    body: `**Position:** the land of the Lotus-eaters, beached.
**Wind:** light, northerly.
**Sea:** slight.
**Aboard:** 528, three of them tied.

Watered at the stream and ate a meal on the sand. Then sent three men inland, two chosen and a herald with them ([[crew/lotus-eaters]]), to find out who lives here.

They did not come back. Went after them myself with a party. The people here are not hostile. They had given our men the fruit they eat, the lotus ([[knowledge/lotus]]), and anyone who eats it stops wanting anything else. The three were sitting with them and did not want to remember the ships, or home, or what they had come for.

Carried them down to the beach. They wept the whole way. Tied them under the rowing benches ([[decisions/drag-back-the-lotus-eaters]]).

Then to the whole crew, from the stern: nobody eats anything here. Nobody goes inland. We embark now.

**Decision:** sail on the morning tide. The three stay tied until they ask for home by name.

Leg: [[voyage/legs/lotus-eaters]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/lotus-eaters.md", "voyage/_index.md", "crew/lotus-eaters.md", "knowledge/lotus.md", "decisions/drag-back-the-lotus-eaters.md"],
    fields: { day: 30, place: "land of the Lotus-eaters", wind: "light north", aboard: 528 },
  },
  {
    path: "voyage/day-31-leaving-the-lotus.md",
    title: "Day 31 -- leaving the lotus coast",
    type: "log",
    created: "2016-08-12",
    updated: "2016-08-12",
    status: "filed",
    tags: ["log", "crew"],
    places: ["place:lotus"],
    summary: "Out on the morning tide. The three men asked for water by midday and for home by evening.",
    body: `**Position:** standing off the lotus coast, northward.
**Wind:** light westerly.
**Sea:** slight.
**Aboard:** 528.

Away at first light, the men sitting to the oars in their places and striking the water together. No one looked back at the shore, which I noticed and was glad of.

The three tied under the benches: by midday all asked for water, which is the first ordinary want. By evening the eldest asked how many days to Ithaca, and I untied him. The other two tomorrow.

Note for the record, since it will not be in the ledger: no man was lost here. Three were nearly lost, without a blow struck, and without anyone wishing them harm. That is a kind of hazard there is no column for.

Course: north. We do not know where north will bring us.

**Decision:** keep the three under watch for two days. Ration the lotus coast's water to a full ten days.

Crew: [[crew/lotus-eaters]], [[crew/roll-calls/day-31]], [[crew/ships/ship-08]]. Leg: [[voyage/legs/lotus-eaters]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/lotus-eaters.md", "voyage/_index.md", "crew/lotus-eaters.md", "crew/roll-calls/day-31.md", "crew/ships/ship-08.md"],
    fields: { day: 31, place: "off the lotus coast", wind: "light west", aboard: 528 },
  },
  {
    path: "voyage/day-96-goat-island.md",
    title: "Day 96 -- the goat island",
    type: "log",
    created: "2016-10-16",
    updated: "2016-10-16",
    status: "filed",
    tags: ["log", "cyclopes"],
    places: ["place:cyclopes"],
    summary: "Came in through fog onto a wooded island full of wild goats, unvisited by anyone. Across the water, smoke and the sound of flocks.",
    body: `**Position:** a small wooded island off the land of the Cyclopes. Beached.
**Wind:** none; thick fog on the approach.
**Sea:** flat.
**Aboard:** 528 across 12 ships; 44 in ship 1.

Came in at night through fog so thick there was no moon and no sight of the shore until the keels touched. Slept on the sand.

At dawn: an island, uninhabited, covered in wild goats that have never seen a hunter. Took bows and spears and hunted in three parties. Nine goats to each ship, ten to mine.

Across a short strait, the mainland. Smoke from fires. The sound of sheep and goats, and voices.

These people do not plough or plant. They have no ships, no assemblies ([[knowledge/cyclopes-customs]]). Each lives in a cave with his own household and pays no attention to the next.

- [ ] Find out who they are
- [ ] Whether they keep the laws for strangers

**Decision:** eleven ships stay here ([[crew/ships/ship-10]] among them). Ship 1 crosses tomorrow to see who lives there ([[decisions/enter-the-cave]]).

Leg: [[voyage/legs/cyclopes]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/cyclopes.md", "voyage/_index.md", "knowledge/cyclopes-customs.md", "crew/ships/ship-10.md", "decisions/enter-the-cave.md"],
    fields: { day: 96, place: "goat island, land of the Cyclopes", wind: "calm, fog", aboard: 528 },
  },
  {
    path: "voyage/day-97-the-cave.md",
    title: "Day 97 -- the cave",
    type: "log",
    created: "2016-10-17",
    updated: "2016-10-19",
    status: "filed",
    tags: ["log", "cyclopes", "losses"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Twelve of us into a cave full of cheese and penned lambs. The owner came home at evening and rolled a stone across the door. Two eaten.",
    body: `**Position:** a cave above the sea, land of the Cyclopes. Ship 1 beached below.
**Wind:** light, off the land.
**Sea:** calm.
**Aboard:** 44 in ship 1 at dawn; twelve of them in the cave with me.

Chose twelve ([[crew/cave-party]]) and took a skin of Maron's wine. The cave was empty of its owner: racks of cheese, pens of lambs and kids, pails of whey.

The men said: take the cheese, drive off the lambs, go. I said we would wait and see him, and whether he would give us gifts. Written plainly: they were right.

He came home at evening with his flocks and a load of firewood, and set a stone in the doorway that twenty-two wagons could not shift ([[knowledge/cyclops-door-stone]]). He asked who we were. I told him we were Greeks from Troy and asked him to respect the gods.

He said the Cyclopes do not care for the gods. He took two men and ate them. Then he slept.

I could have killed him with a sword in the night. We could not have moved the stone.

**Decision:** wait ([[decisions/wait-for-polyphemus]]). Do nothing that leaves us shut in.

Journal: [[journal/day-97]]. Leg: [[voyage/legs/cyclopes]]. See [[people/polyphemus]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/cyclopes.md", "people/polyphemus.md", "voyage/_index.md", "crew/cave-party.md", "knowledge/cyclops-door-stone.md", "decisions/wait-for-polyphemus.md", "journal/day-97.md"],
    fields: { day: 97, place: "the cave", wind: "light", aboard: 42, lost: 2 },
  },
  {
    path: "voyage/day-98-the-stake.md",
    title: "Day 98 -- the stake",
    type: "log",
    created: "2016-10-18",
    updated: "2016-10-19",
    status: "filed",
    tags: ["log", "cyclopes", "losses"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Two more at morning, two at evening. Then the wine, the name Nobody, and the olive stake heated in the fire.",
    body: `**Position:** the cave.
**Wind:** none felt inside.
**Aboard:** 38 in ship 1, eight in the cave with me.

Morning: two more. He drove the flocks out and set the stone back behind him.

There was a staff of green olive wood in the pen, as long as a ship's mast. We cut a fathom off it, smoothed it, sharpened the end and hardened it in the fire. Hid it in the dung. Drew lots for who would hold it with me. Four.

Evening: two more. [[crew/antiphus]] was the second of them.

Then I gave him Maron's wine, unmixed. He drank three bowls and asked my name. I told him: Nobody ([[decisions/nobody-as-the-name]]). He said he would eat Nobody last, as his gift to me ([[oaths/xenia-polyphemus]]), and fell asleep.

The four and I drove the stake into his eye and turned it like a shipwright's drill ([[decisions/blind-rather-than-kill]]).

He shouted for his neighbours. They called through the stone: was anyone hurting him? He said, "Nobody is hurting me." They went home.

**Decision:** out under the rams at first light. One man under each three, myself under the last.

Rule kept: [[notes/do-not-give-my-name]]. Leg: [[voyage/legs/cyclopes]]. Part of [[voyage/_index]].`,
    links: ["notes/do-not-give-my-name.md", "voyage/legs/cyclopes.md", "voyage/_index.md", "crew/antiphus.md", "decisions/nobody-as-the-name.md", "oaths/xenia-polyphemus.md", "decisions/blind-rather-than-kill.md"],
    fields: { day: 98, place: "the cave", aboard: 38, lost: 4 },
  },
  {
    path: "voyage/day-99-escape.md",
    title: "Day 99 -- out of the cave",
    type: "log",
    created: "2016-10-19",
    updated: "2016-10-19",
    status: "filed",
    tags: ["log", "cyclopes", "poseidon"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes"],
    summary: "Out under the rams. Clear of the beach, I shouted my name back at him. He prayed to his father, and threw the second rock.",
    body: `**Position:** the shore below the cave, then the goat island.
**Wind:** light off the land, fair for the island.
**Sea:** calm, then a swell from the thrown rock.
**Aboard:** 38 in ship 1; 522 in the fleet.

Out at dawn, each man tied under three rams, I under the largest, holding its fleece. He felt their backs at the door and nothing else.

Drove the flock down to the ship and rowed out. At a shout's distance I called to him. He broke off a hilltop and threw it, and it fell ahead of the bow and washed us back to the beach. I poled us off.

Then, further out, against every man aboard begging me to stop, I told him my name, my father's name, and my island.

He prayed to Poseidon his father: that I should never reach home, or if I must, late, alone, in another's ship, and find trouble in my house ([[oaths/polyphemus-curse]]).

Reached the island. Shared the sheep. Sacrificed the ram to Zeus. He did not take it ([[omens/day-99-ram-refused]]).

**Decision:** recorded separately and reversed too late: [[decisions/name-at-the-stern]].

See [[people/poseidon]]. Roll call: [[crew/roll-calls/day-99]]. Journal: [[journal/day-100]]. Leg: [[voyage/legs/cyclopes]]. Part of [[voyage/_index]].`,
    links: ["decisions/name-at-the-stern.md", "people/poseidon.md", "voyage/legs/cyclopes.md", "voyage/_index.md", "oaths/polyphemus-curse.md", "omens/day-99-ram-refused.md", "crew/roll-calls/day-99.md", "journal/day-100.md"],
    fields: { day: 99, place: "land of the Cyclopes", wind: "light off the land", aboard: 522 },
  },
  {
    path: "voyage/day-132-aeolia-arrival.md",
    title: "Day 132 -- Aeolia",
    type: "log",
    created: "2016-11-21",
    updated: "2016-11-21",
    status: "filed",
    tags: ["log", "winds"],
    places: ["place:aeolia"],
    summary: "Landfall on the floating island of Aeolus: a wall of bronze and sheer cliffs, a household of twelve, and a host who wanted the whole story.",
    body: `**Position:** Aeolia, the floating island. Beached below the wall.
**Wind:** variable, every quarter in turn, which on this island is normal.
**Sea:** slight.
**Aboard:** 522 across 12 ships; 38 in ship 1.

An island that floats. All round it a wall of unbreakable bronze, and sheer rock rising from the water.

[[people/aeolus]], son of Hippotas, lives here with his wife and twelve children, six sons and six daughters, who are married to one another. Every day they feast in the hall.

He received us as guests ([[oaths/xenia-aeolus]]) and asked for everything: Troy, the ships, the return so far. I told it in order. He listened to all of it and asked good questions about the winds off Malea.

He is the keeper of the winds; Zeus gave him the office ([[knowledge/aeolus]]). He can still or rouse any of them.

> Did not ask for passage tonight. A guest who asks on the first night has not yet been a guest.

**Decision:** stay as long as we are welcome. When it is time, ask once, clearly, and wait for the answer. Do not ask twice.

Leg: [[voyage/legs/aeolia]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeolia.md", "voyage/_index.md", "people/aeolus.md", "oaths/xenia-aeolus.md", "knowledge/aeolus.md"],
    fields: { day: 132, place: "Aeolia", wind: "variable", aboard: 522 },
  },
  {
    path: "voyage/day-162-aeolia-departure.md",
    title: "Day 162 -- the bag",
    type: "log",
    created: "2016-12-21",
    updated: "2016-12-21",
    status: "filed",
    tags: ["log", "winds"],
    places: ["place:aeolia"],
    summary: "Aeolus gave passage: every hindering wind bound in an ox-hide bag with a silver cord, stowed in ship 1. The west wind left free.",
    body: `**Position:** Aeolia, standing out at dusk.
**Wind:** west, fair, steady. The only wind loose.
**Sea:** slight.
**Aboard:** 522.

A month in his hall, and yesterday I asked for passage. At first light Aeolus gave his answer. He flayed an ox of nine seasons and made a bag of the hide, and in it he bound the courses of all the howling winds. He closed it himself with a shining silver cord so that not a breath escaped, and had it stowed in my ship, under the stern deck.

The west wind ([[knowledge/zephyrus]]) he left free to carry us home.

The crew watched it come aboard. Nobody asked what was in it. I did not say ([[decisions/accept-the-bag-of-winds]]).

Sailed at dusk with the whole fleet. Course east, and a little north, for Ithaca.

- [x] Bag stowed, cord sealed
- [x] Steering oar: myself, all watches
- [ ] Tell the crew what the bag holds

**Decision:** I take the sheet and the oar myself until the island is under the bow ([[decisions/keep-the-helm-nine-days]]).

The bag: [[crew/aeolia-bag]]. Leg: [[voyage/legs/aeolia]]. Next: [[voyage/legs/ithaca-in-sight]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeolia.md", "voyage/legs/ithaca-in-sight.md", "voyage/_index.md", "knowledge/zephyrus.md", "decisions/accept-the-bag-of-winds.md", "decisions/keep-the-helm-nine-days.md", "crew/aeolia-bag.md"],
    fields: { day: 162, place: "Aeolia", wind: "west", aboard: 522 },
  },
  {
    path: "voyage/day-167-west-wind-holding.md",
    title: "Day 167 -- the west wind holding",
    type: "log",
    created: "2016-12-26",
    updated: "2016-12-26",
    status: "filed",
    tags: ["log", "winds"],
    places: ["place:aeolia", "place:ithaca"],
    summary: "Fifth day on the west wind. The fleet in company, the sea kind, and I have not slept.",
    body: `**Position:** open sea, roughly halfway from Aeolia to Ithaca by the pilots' reckoning.
**Wind:** west, steady, moderate. Has not varied.
**Sea:** slight, long following swell.
**Aboard:** 522.

Fifth day. The wind has not backed or veered a point. The ships run in two lines, and every dawn I count twelve.

I have held the sheet since Aeolia ([[decisions/keep-the-helm-nine-days]]). My hands have stiffened to the shape of it. The crew offer to take it and I refuse, not because I distrust them at the oar but because this is the one passage where the outcome turns on nothing going wrong, and I would rather it went wrong in my hands.

The men talk at night. I hear the word gold more than once ([[crew/aeolia-bag]]). I have assumed it is about Troy.

Water good. Stores good. Nobody sick.

**Decision:** no change. Keep the sheet. Sleep when the island is in sight and not before.

Watches: [[crew/watch-rota]]. Leg: [[voyage/legs/ithaca-in-sight]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/ithaca-in-sight.md", "voyage/_index.md", "decisions/keep-the-helm-nine-days.md", "crew/aeolia-bag.md", "crew/watch-rota.md"],
    fields: { day: 167, place: "open sea", wind: "west", aboard: 522 },
  },
  {
    path: "voyage/day-171-ithaca-in-sight.md",
    title: "Day 171 -- Ithaca in sight",
    type: "log",
    created: "2016-12-30",
    updated: "2016-12-31",
    status: "filed",
    tags: ["log", "ithaca", "winds"],
    places: ["place:ithaca"],
    summary: "On the tenth day the island came up and we could see men tending fires. I slept. The crew opened the bag.",
    body: `**Position:** in sight of Ithaca, close enough to see fires on the shore and men moving at them.
**Wind:** west, then every wind at once.
**Sea:** slight, then very rough.
**Aboard:** 522.

Nine days of sailing, nine nights. On the tenth morning the island came up out of the sea where it should be. [[ithaca/island/neriton]] above it. Fires on the shore.

I let go of the sheet and slept. I had not slept in nine days.

Entry completed the next day, from what the men told me:

They talked among themselves. They said I was bringing home gold and silver from Troy, and now a gift from Aeolus on top of it, and they were bringing home empty hands. They untied the silver cord ([[crew/aeolia-bag]]).

All the winds came out together. The storm took the fleet out to sea, weeping, away from the island.

I woke, and thought about going over the side. I lay down in the ship instead, and covered my head.

**Decision:** none was possible. Recorded so it is not remembered as anything other than what it was.

Journal: [[journal/day-172]]. Leg: [[voyage/legs/ithaca-in-sight]]. Goal: [[goals/return-to-ithaca]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/ithaca-in-sight.md", "goals/return-to-ithaca.md", "voyage/_index.md", "ithaca/island/neriton.md", "crew/aeolia-bag.md", "journal/day-172.md"],
    fields: { day: 171, place: "off Ithaca", wind: "all quarters", aboard: 522 },
  },
  {
    path: "voyage/day-172-aeolus-refuses.md",
    title: "Day 172 -- Aeolus refuses",
    type: "log",
    created: "2016-12-31",
    updated: "2016-12-31",
    status: "filed",
    tags: ["log", "winds"],
    places: ["place:aeolia"],
    summary: "Blown back to Aeolia. Went to the hall and asked again. He sent us off the island as men the gods hate.",
    body: `**Position:** Aeolia, the same beach as ten days ago.
**Wind:** none. Aeolus has stilled them.
**Sea:** calm.
**Aboard:** 522.

The storm put us back on Aeolia. Watered, ate on the shore. Then I went up with one companion and a herald to the hall, and sat at the doorposts as a suppliant ([[knowledge/suppliants]]).

They were astonished. "What god was against you? We sent you off with everything you needed to reach home."

I told them: my crew, and sleep.

Aeolus said ([[omens/day-172-aeolus-reading]]):

> Get off my island, worst of living men. It is not right for me to help or send on his way a man the blessed gods hate. Go. You came here hated by the gods.

We left. There is no wind. The men row, and the row has no end in sight, and every man knows whose fault the empty sail is, and also that it was not only one man's.

- [ ] Rule for the future: anything aboard that could be mistaken for treasure is explained to the crew on the day it comes aboard. Added to [[crew/standing-orders]].

**Decision:** row. Any course but this one.

Decision: [[decisions/return-to-aeolus]]. Roll call: [[crew/roll-calls/day-172]]. Leg: [[voyage/legs/ithaca-in-sight]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/ithaca-in-sight.md", "voyage/_index.md", "knowledge/suppliants.md", "omens/day-172-aeolus-reading.md", "crew/standing-orders.md", "decisions/return-to-aeolus.md", "crew/roll-calls/day-172.md"],
    fields: { day: 172, place: "Aeolia", wind: "none", aboard: 522 },
  },
  {
    path: "voyage/day-205-laestrygonian-harbour.md",
    title: "Day 205 -- the Laestrygonian harbour",
    type: "log",
    created: "2017-02-02",
    updated: "2017-02-03",
    status: "filed",
    tags: ["log", "losses"],
    places: ["place:laestrygonians"],
    summary: "Eleven ships inside a still harbour, mine outside on a rock. By evening, one ship.",
    body: `**Position:** the harbour of the Laestrygonians, Telepylus. Ship 1 moored to a rock outside the mouth.
**Wind:** none. Flat calm inside.
**Sea:** smooth as a pond inside; slight outside.
**Aboard:** 522 at dawn. 38 at nightfall.

A fine harbour: cliffs unbroken on both sides, two headlands facing each other across a narrow mouth. No wave ever rises inside it ([[knowledge/laestrygonians]]). The captains brought their ships in and moored them close together.

I kept mine outside, tied to the rock at the end. Habit, not foresight: [[decisions/moor-outside-the-harbour]].

Sent three up the road. They met a girl at a spring, the king's daughter, who sent them to her father's house. His wife was the size of a mountain. [[people/antiphates]] came from the assembly and seized one of them for his meal. Two ran.

He raised the cry. They came by thousands to the cliffs above the harbour and threw down rocks a man could barely lift. The noise of ships breaking and men dying came up together. They speared the crews like fish and carried them off.

I drew my sword and cut the cable ([[decisions/cut-the-cable]]). Shouted to row. They rowed.

**Decision:** away. No stopping until we are out of sight of this coast.

Leg: [[voyage/legs/laestrygonians]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/laestrygonians.md", "voyage/_index.md", "knowledge/laestrygonians.md", "decisions/moor-outside-the-harbour.md", "people/antiphates.md", "decisions/cut-the-cable.md"],
    fields: { day: 205, place: "Laestrygonian harbour", wind: "calm", aboard: 38, lost: 484 },
  },
  {
    path: "voyage/day-206-one-ship.md",
    title: "Day 206 -- one ship",
    type: "log",
    created: "2017-02-03",
    updated: "2017-02-03",
    status: "filed",
    tags: ["log", "losses", "crew"],
    places: ["place:laestrygonians"],
    summary: "The first morning with one ship. The fleet's count, written out once, so nobody has to do it again.",
    body: `**Position:** open water south of the Laestrygonian coast.
**Wind:** light, variable.
**Sea:** slight.
**Aboard:** 38 and myself.

Rowed through the night. Nobody stopped. At dawn there was no land in sight and no other hull. There will not be one again.

Written out once (kept since in [[crew/fleet-strength]]):

| | Ships | Crew |
|---|---|---|
| Out of Troy | 12 | 600 |
| After Ismarus | 12 | 528 |
| After the cave | 12 | 522 |
| After the harbour | 1 | 38 |

Each of the eleven carried forty-four. Mine carried fifty, less six at Ismarus and six in the cave.

There is no ceremony for this. We cannot call the names; there are too many, and nobody knows the crews of the other ships by name. We called the ships by number instead. Eleven times ([[crew/losses/laestrygonians]]).

The men are glad to be alive and grieving for their friends. Both at once, all day.

**Decision:** south, for any coast that is not this one. Ration to twenty days.

Leg: [[voyage/legs/laestrygonians]]. Roll call: [[crew/roll-calls/day-206]]. Journal: [[journal/day-206]]. Crew: [[crew/_index]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/laestrygonians.md", "crew/_index.md", "voyage/_index.md", "crew/fleet-strength.md", "crew/losses/laestrygonians.md", "crew/roll-calls/day-206.md", "journal/day-206.md"],
    fields: { day: 206, place: "open sea", wind: "variable", aboard: 38 },
  },
  {
    path: "voyage/day-246-aeaea-arrival.md",
    title: "Day 246 -- Aeaea",
    type: "log",
    created: "2017-03-15",
    updated: "2017-03-15",
    status: "filed",
    tags: ["log", "aeaea"],
    places: ["place:aeaea"],
    summary: "Came into a harbour without a word, led by some god. Lay two days on the shore, eating our hearts out. Smoke from deep in the woods.",
    body: `**Position:** Aeaea, a sheltered harbour. Ship beached.
**Wind:** light, onshore.
**Sea:** calm.
**Aboard:** 38 and myself.

Brought the ship in silently. Somebody guided it; nobody aboard knew this coast. Lay on the beach the rest of the morning, worn out, and grieving.

At midday I took a spear and sword and climbed a rise to see. The island is low and ringed by sea. Smoke in the middle of it ([[knowledge/reading-a-coast]]), through thick oak and scrub.

Turned back first. On the way down a stag ([[omens/day-246-the-stag]]) crossed the path to drink at the river, and I killed it with the spear, and carried it down to the ship on my neck, tied with twisted willow.

We ate until dark. The men need meat and rest more than they need to know where we are.

- [ ] Find out who lives under the smoke
- [ ] Divide the crew in two companies; one explores, one keeps the ship

**Decision:** two parties tomorrow, drawn by lot ([[decisions/split-the-crew-on-aeaea]]). Eurylochus takes one; I keep the other at the ship.

Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "knowledge/reading-a-coast.md", "omens/day-246-the-stag.md", "decisions/split-the-crew-on-aeaea.md"],
    fields: { day: 246, place: "Aeaea", wind: "light onshore", aboard: 38 },
  },
  {
    path: "voyage/day-247-the-swine.md",
    title: "Day 247 -- the swine",
    type: "log",
    created: "2017-03-16",
    updated: "2017-03-16",
    status: "filed",
    tags: ["log", "aeaea", "crew"],
    people: ["person:eurylochus", "person:circe"],
    places: ["place:aeaea"],
    summary: "Eurylochus's party went to the hall in the woods. He came back alone. The other twenty-two had gone in and not come out.",
    body: `**Position:** Aeaea, beached.
**Wind:** light.
**Aboard:** 38, of whom 22 now unaccounted for.

The lot ([[decisions/split-the-crew-on-aeaea]]) fell to [[crew/eurylochus]]. He took twenty-two ([[crew/aeaea-scouting-party]]). [[crew/polites]] went, and said afterwards it was the best house he had seen.

They found a hall of polished stone in a clearing. Wolves and lions about it that fawned on them like dogs. Inside, a woman singing at a loom. She called them in. Eurylochus suspected a trick and waited outside.

The rest went in. He watched the doors and they did not come out.

He came back running, and could not speak for some time. Then he told it, and begged me not to go, and to take whoever was left and sail.

I am going. They are my crew, and the count is not closed.

Eurylochus stays with the ship. He will not come. I have not ordered him to.

**Decision:** alone, at once, with sword and bow ([[decisions/go-to-circe-alone]]). If not back by tomorrow's dark, the ship sails without me.

See [[people/circe]]. Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["crew/eurylochus.md", "people/circe.md", "voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "decisions/split-the-crew-on-aeaea.md", "crew/aeaea-scouting-party.md", "crew/polites.md", "decisions/go-to-circe-alone.md"],
    fields: { day: 247, place: "Aeaea", wind: "light", aboard: 38 },
  },
  {
    path: "voyage/day-248-moly.md",
    title: "Day 248 -- moly",
    type: "log",
    created: "2017-03-17",
    updated: "2017-03-17",
    status: "filed",
    tags: ["log", "aeaea", "gods"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "Hermes on the path with a root against her drugs. Circe's cup failed. She swore the great oath and restored the men, younger than before.",
    body: `**Position:** Circe's hall, Aeaea.
**Aboard:** 38. All accounted for again.

On the path through the woods a young man met me: [[people/hermes]], with his staff. He told me what she had done. My men are in her sties, turned to swine with a drug in their wine and a touch of her wand ([[knowledge/circe-drugs]]), with their minds still their own.

He pulled a plant from the ground and showed me its nature: root dark, flower like milk. The gods call it moly ([[knowledge/moly]]). Hard for men to dig.

His instructions, exactly:

1. Take her cup. The moly makes it harmless.
2. When she strikes with the wand, draw the sword as if to kill her.
3. She will invite you to her bed. Do not refuse, but make her swear first, by the great oath of the gods, to plan no other harm.

It went as he said. She swore ([[oaths/circe-no-harm]]). Then she went down to the sties and anointed each of the men, and they stood up men again, younger and taller than before, and wept.

**Decision:** fetch the rest of the crew from the ship. Haul her up and stow the tackle.

See [[people/circe]]. Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["people/circe.md", "voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "people/hermes.md", "knowledge/circe-drugs.md", "knowledge/moly.md", "oaths/circe-no-harm.md"],
    fields: { day: 248, place: "Aeaea", aboard: 38, source: "Hermes" },
  },
  {
    path: "voyage/day-345-midsummer.md",
    title: "Day 345 -- midsummer on Aeaea",
    type: "log",
    created: "2017-06-22",
    updated: "2017-06-22",
    status: "filed",
    tags: ["log", "aeaea", "seasons"],
    places: ["place:aeaea"],
    summary: "The longest day. The sailing season at its height, and the ship on rollers in a cave.",
    body: `**Position:** Aeaea, ship hauled up and housed.
**Wind:** steady north-westerly, every afternoon. Good sailing wind.
**Sea:** slight.
**Aboard:** 38 ashore.

The longest day. A hundred days on the island.

The afternoon wind has blown from the same quarter for a month. It is the wind we would want for the passage south and east. I note it because I have caught myself noting it every afternoon and then not writing it down.

The men are well. Fed at her table every day, meat and sweet wine without end. Their wounds have healed. Their arguments have stopped. Eurylochus does not argue with anything any more.

Hull inspected: sound. Tackle in the caves, dry. Oars stacked. Nothing prevents us leaving except a decision to leave.

> Write it down: the season for sailing is now, and it is going.

**Decision:** none made ([[decisions/stay-the-year]]). Recorded as none, so the gap is visible.

Later: [[journal/day-430]]. Leg: [[voyage/legs/aeaea-first-stay]]. Goal: [[goals/return-to-ithaca]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeaea-first-stay.md", "goals/return-to-ithaca.md", "voyage/_index.md", "decisions/stay-the-year.md", "journal/day-430.md"],
    fields: { day: 345, place: "Aeaea", wind: "north-west", aboard: 38 },
  },
  {
    path: "voyage/day-437-equinox.md",
    title: "Day 437 -- the autumn equinox",
    type: "log",
    created: "2017-09-22",
    updated: "2017-09-22",
    status: "filed",
    tags: ["log", "aeaea", "seasons"],
    places: ["place:aeaea"],
    summary: "Day and night equal. The sailing season closes with the Pleiades. Another winter on Aeaea is now not a choice but a fact.",
    body: `**Position:** Aeaea, ship housed.
**Wind:** turning, gusty, first of the autumn rain.
**Sea:** moderate and rising.
**Aboard:** 38 ashore.

Day and night equal. By the pilots' rule, once the Pleiades ([[knowledge/pleiades]]) set in the evening no ship should be on open water. That is close now.

So the decision not taken in summer is now taken for us. We winter here. Whatever the reasons were, there is now a reason that would satisfy anyone.

That is worse, not better. A delay with a good excuse at the end of it hides the months that had none.

Stock-take, since the log has been thin:

- Men: 38, all fit
- Hull: sound; seams want caulking before spring
- Sail: needs mending at the foot
- Stores: none needed while we are here

- [ ] Caulk in early spring
- [ ] Mend the sail this winter
- [ ] Name a day to leave, in writing, before midwinter

**Decision:** winter on Aeaea ([[decisions/stay-the-year]]). Fix the day of leaving before the turn of the year.

Journal: [[journal/day-430]]. Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "knowledge/pleiades.md", "decisions/stay-the-year.md", "journal/day-430.md"],
    fields: { day: 437, place: "Aeaea", wind: "gusty, variable", aboard: 38 },
  },
  {
    path: "voyage/day-528-midwinter.md",
    title: "Day 528 -- midwinter on Aeaea",
    type: "log",
    created: "2017-12-22",
    updated: "2017-12-22",
    status: "filed",
    tags: ["log", "aeaea", "seasons"],
    places: ["place:aeaea"],
    summary: "The shortest day. The day of leaving was to be fixed by now. It was not.",
    body: `**Position:** Aeaea.
**Wind:** north, cold, gale at times.
**Sea:** rough.
**Aboard:** 38 ashore.

The shortest day. The task on the list from the equinox was to fix a day of leaving before now. It is unticked.

What the log should say, and so does: I have not asked [[people/circe]] how to get home. I have not asked because I do not know what she will say, and while I have not asked I do not have to act on it.

The sail was mended. The men did that without being told.

This is a careful record and it should be honest. The longest entries this season have been about the weather.

- [x] Mend the sail
- [ ] Name a day to leave
- [ ] Ask Circe for the route

**Decision:** deferred again ([[decisions/stay-the-year]]). Recorded as deferred.

Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "people/circe.md", "decisions/stay-the-year.md"],
    fields: { day: 528, place: "Aeaea", wind: "north", aboard: 38 },
  },
  {
    path: "voyage/day-608-the-crew-ask.md",
    title: "Day 608 -- the crew ask",
    type: "log",
    created: "2018-03-12",
    updated: "2018-03-12",
    status: "filed",
    tags: ["log", "aeaea", "crew"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "A year gone. The crew took me aside and asked whether I meant to go home at all. That night I asked Circe.",
    body: `**Position:** Aeaea.
**Wind:** turning to spring; moderate north.
**Sea:** moderate.
**Aboard:** 38.

The seasons have come round. The months have gone and the long days are coming back.

This morning my crew took me aside, all of them together, and said: you are possessed. Remember your country, if it is fated for you to reach it.

They were right and I said so.

That night I went to Circe and clasped her knees ([[knowledge/suppliants]]) and asked her to keep the promise she made, to send me home. She said she would not keep anyone against his will. But first there is another journey. To the house of Hades, to ask the shade of Teiresias, whose mind is whole among the dead, the way home and the measure of it.

I sat on the bed and wept, and did not want to see the sun.

She gave the instructions. A north wind will carry the ship. Where to beach. What to pour. What to sacrifice.

**Decision:** leave as soon as the ship is down and loaded. Not home: to the dead first ([[decisions/go-to-the-dead]]).

See [[people/circe]], [[people/teiresias]]. Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["people/circe.md", "people/teiresias.md", "voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "knowledge/suppliants.md", "decisions/go-to-the-dead.md"],
    fields: { day: 608, place: "Aeaea", wind: "north", aboard: 38 },
  },
  {
    path: "voyage/day-611-elpenor.md",
    title: "Day 611 -- leaving Aeaea; Elpenor",
    type: "log",
    created: "2018-03-15",
    updated: "2018-03-24",
    status: "filed",
    tags: ["log", "aeaea", "losses"],
    people: ["person:elpenor"],
    places: ["place:aeaea"],
    summary: "Sailed for the dead in the morning. Elpenor, the youngest, had slept on the roof and fell at the noise of us leaving. Not missed until we were out.",
    body: `**Position:** Aeaea, launching; then open water on Circe's north wind.
**Wind:** north, fair, as promised.
**Sea:** slight.
**Aboard:** 37 and myself. 38 believed at the time.

Ship down the rollers at dawn. Stores in, mast stepped. The crew in good heart for the first time in a year.

Annotated nine days later, at the dead:

Elpenor, the youngest, not much use in a fight and not much sense, had drunk at night and gone up on Circe's roof to sleep in the cool. Woke at the noise and shouting of the crew going down to the ship, forgot the long ladder, and walked off the edge. His neck broke: [[crew/losses/aeaea]].

We did not count heads at the shore. Nobody knew until his shade met me at the pit ([[crew/roll-calls/day-620]]).

| | Aboard |
|---|---|
| Arrived Aeaea | 38 |
| Left Aeaea | 37 |

- [ ] Count heads at every embarkation, without exception ([[crew/standing-orders]])

**Decision:** sail, as given. The correction to the count is in the line above.

See [[crew/elpenor]]. Leg: [[voyage/legs/aeaea-first-stay]]. Part of [[voyage/_index]].`,
    links: ["crew/elpenor.md", "voyage/legs/aeaea-first-stay.md", "voyage/_index.md", "crew/losses/aeaea.md", "crew/roll-calls/day-620.md", "crew/standing-orders.md"],
    fields: { day: 611, place: "Aeaea", wind: "north", aboard: 37, lost: 1 },
  },
  {
    path: "voyage/day-620-acheron.md",
    title: "Day 620 -- the house of the dead",
    type: "log",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "filed",
    tags: ["log", "forecast", "dead"],
    people: ["person:teiresias", "person:elpenor"],
    places: ["place:acheron"],
    summary: "The pit, the offerings, the dead coming up in crowds. Elpenor first. Then Teiresias, who gave the forecast. Then my mother.",
    body: `**Position:** the place Circe named, where Pyriphlegethon and Cocytus flow into Acheron. Ship beached.
**Wind:** north, falling to nothing.
**Sea:** calm. No light to speak of.
**Aboard:** 37, on the beach.

Did as instructed. [[crew/perimedes]] and Eurylochus held the victims. I dug the pit with my sword, a cubit each way, and poured round it for all the dead: honey and milk, then sweet wine, then water, and barley over it. Then cut the throats of the ram and the ewe over the pit.

They came up out of the dark in crowds. I sat with the sword drawn and kept them from the blood.

First, Elpenor. Unburied, unwept. He asked to be burned with his armour and his oar set on the barrow. I promised ([[oaths/promise-to-elpenor]]).

Then Teiresias, with a golden staff. He drank and spoke: [[knowledge/teiresias-forecast]].

Then my mother, [[people/anticleia]]. I did not know she was dead. She died of missing me. Three times I tried to hold her, and three times she went through my hands like a shadow.

Then the others I knew from Troy: Agamemnon, Achilles, Ajax. Written up at [[voyage/day-622-leaving-the-dead]].

**Decision:** back to Aeaea to bury Elpenor before anything else.

See [[people/teiresias]], [[crew/elpenor]]. Journal: [[journal/day-621]]. Leg: [[voyage/legs/house-of-the-dead]]. Part of [[voyage/_index]].`,
    links: ["knowledge/teiresias-forecast.md", "people/teiresias.md", "crew/elpenor.md", "voyage/legs/house-of-the-dead.md", "voyage/_index.md", "crew/perimedes.md", "oaths/promise-to-elpenor.md", "people/anticleia.md", "journal/day-621.md", "voyage/day-622-leaving-the-dead.md"],
    fields: { day: 620, place: "the Acheron", wind: "falling calm", aboard: 37, source: "Teiresias" },
  },
  {
    path: "voyage/day-622-leaving-the-dead.md",
    title: "Day 622 -- leaving the dead",
    type: "log",
    created: "2018-03-26",
    updated: "2018-03-26",
    status: "filed",
    tags: ["log", "dead"],
    places: ["place:acheron", "place:aeaea"],
    summary: "What Agamemnon, Achilles and Ajax said at the pit on day 620, written up. Then the dead came in thousands, and I was afraid, and we went down to the ship.",
    body: `**Position:** the shore of Ocean, launching; then the stream of Ocean, under oars and sail.
**Wind:** fair for Aeaea.
**Sea:** a long swell on the stream.
**Aboard:** 37.

What else was said at the pit on day 620 ([[voyage/day-620-acheron]]), after my mother. Recorded in brief, because the full account is not for a log:

- **Agamemnon.** Murdered at his own table, the day he came home, by his wife and her lover. His advice: come home in secret. Trust no woman. He said Penelope was not that kind, and to come in secret anyway.
- **Achilles.** I told him he was honoured among the dead. He said he would rather be a hired hand on a poor man's farm than king of all of them. He asked for news of his son. I gave it ([[people/neoptolemus]]), and he went off across the meadow glad.
- **Ajax.** Still angry over the arms of Achilles. I spoke to him gently. He gave no answer and went away into the dark.

I stayed by the trench through the next day, in case others I knew would come. This morning they came in thousands, with a noise, and I was afraid that something worse would be sent up out of the dark. I went to the ship and told the crew to cast off.

**Decision:** Aeaea, then Elpenor, then the route.

The dead: [[people/agamemnon]], [[people/achilles]], [[people/ajax-son-of-telamon]]. Leg: [[voyage/legs/house-of-the-dead]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/house-of-the-dead.md", "voyage/_index.md", "people/neoptolemus.md", "people/agamemnon.md", "people/achilles.md", "people/ajax-son-of-telamon.md", "voyage/day-620-acheron.md"],
    fields: { day: 622, place: "the Acheron", wind: "fair", aboard: 37 },
  },
  {
    path: "voyage/day-623-aeaea-return.md",
    title: "Day 623 -- back on Aeaea",
    type: "log",
    created: "2018-03-27",
    updated: "2018-03-27",
    status: "filed",
    tags: ["log", "aeaea"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "Beached at Aeaea in the dark and slept on the sand. Circe came down with bread, meat and wine, and called us twice-dying.",
    body: `**Position:** Aeaea, the same beach.
**Wind:** light.
**Sea:** calm.
**Aboard:** 37.

Came in at night and beached her. Slept on the shore where we fell.

At first light we sent men up to the hall to fetch Elpenor's body. The rest cut wood on the headland.

Circe knew we were back before we came up. She came down herself with her attendants carrying bread, a great deal of meat and red wine. Stood among us and said: men who went down alive to Hades, twice-dying, when other men die once.

She said: eat today, all day. At dawn you will sail. I will give you the way, and the signs, so that you do not suffer for want of a plan, on sea or on land.

She did not give it at dawn. That line is written in the log as she said it, and it is the last thing written about the route for four hundred days ([[decisions/wait-out-the-seasons]]).

**Decision:** bury Elpenor tomorrow as he asked ([[decisions/bury-elpenor-first]]). Then hear the route.

See [[people/circe]]. Leg: [[voyage/legs/aeaea-return]]. Part of [[voyage/_index]].`,
    links: ["people/circe.md", "voyage/legs/aeaea-return.md", "voyage/_index.md", "decisions/wait-out-the-seasons.md", "decisions/bury-elpenor-first.md"],
    fields: { day: 623, place: "Aeaea", wind: "light", aboard: 37 },
  },
  {
    path: "voyage/day-624-elpenor-buried.md",
    title: "Day 624 -- Elpenor buried",
    type: "log",
    created: "2018-03-28",
    updated: "2018-03-28",
    status: "filed",
    tags: ["log", "aeaea", "crew"],
    people: ["person:elpenor"],
    places: ["place:aeaea"],
    summary: "Burned with his armour on the headland, a barrow raised, and his oar set upright on top of it. The promise to his shade, kept.",
    body: `**Position:** the headland above the beach, Aeaea.
**Wind:** light onshore; smoke blew inland.
**Aboard:** 37.

Brought him down from the hall. Cut timber at the point of the headland, where it runs furthest out, and burned him there with his armour, grieving and shedding tears.

When the body and the armour were burned, we raised a barrow ([[crew/barrow-on-aeaea]]), and dragged up a stone to stand on it as a marker. On the very top we planted his oar, the oar he rowed with when he was alive, as he asked ([[oaths/promise-to-elpenor]]).

> Heap a mound for me on the shore of the grey sea, for an unlucky man, so that those yet to come will know of me.

Every promise made at the pit has now been kept except the one I made to myself, which is the return.

- [x] Burn him with his armour
- [x] Barrow on the shore
- [x] The oar on top

**Decision:** closed ([[decisions/bury-elpenor-first]]). His name stays in the crew ledger with the date he died, not the date we found out.

See [[crew/elpenor]], [[crew/_index]]. Leg: [[voyage/legs/aeaea-return]]. Part of [[voyage/_index]].`,
    links: ["crew/elpenor.md", "crew/_index.md", "voyage/legs/aeaea-return.md", "voyage/_index.md", "crew/barrow-on-aeaea.md", "oaths/promise-to-elpenor.md", "decisions/bury-elpenor-first.md"],
    fields: { day: 624, place: "Aeaea", aboard: 37 },
  },
  {
    path: "voyage/day-800-season-closing.md",
    title: "Day 800 -- the season closing again",
    type: "log",
    created: "2018-09-20",
    updated: "2018-09-20",
    status: "filed",
    tags: ["log", "aeaea", "seasons"],
    places: ["place:aeaea"],
    summary: "Second autumn on Aeaea. The route still not given. Another winter.",
    body: `**Position:** Aeaea, ship hauled up again.
**Wind:** north-easterly gusts, the first autumn weather.
**Sea:** moderate, rising.
**Aboard:** 37 ashore.

The equinox again. Second time on this island. The ship was hauled back up and housed after the burial; it has not been in the water since.

The reasons in the log since spring, as written:

| When | Reason given |
|---|---|
| Spring | the burial ([[crew/barrow-on-aeaea]]), then Circe's feast |
| Early summer | caulking, which took eleven days |
| High summer | Circe had not given the route |
| Late summer | had not asked for it again |
| Now | the season is closing |

Read in a column, it is not a set of reasons. It is a single reason in five forms.

The crew have not come to me this time. That is worse than if they had.

- [ ] Ask Circe for the route. Name the day.

**Decision:** winter ([[decisions/wait-out-the-seasons]]). The route asked for before midwinter, without fail.

Leg: [[voyage/legs/aeaea-return]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/aeaea-return.md", "voyage/_index.md", "crew/barrow-on-aeaea.md", "decisions/wait-out-the-seasons.md"],
    fields: { day: 800, place: "Aeaea", wind: "north-east", aboard: 37 },
  },
  {
    path: "voyage/day-892-midwinter.md",
    title: "Day 892 -- second midwinter on Aeaea",
    type: "log",
    created: "2018-12-21",
    updated: "2018-12-21",
    status: "filed",
    tags: ["log", "aeaea", "seasons"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "Asked for the route. She said: in the spring, when the sea opens, on the day before you sail. Recorded as an answer.",
    body: `**Position:** Aeaea.
**Wind:** north, hard, cold.
**Sea:** rough. Nothing could sail.
**Aboard:** 37.

Asked her. It is done. The task carried since the first midwinter is closed.

Her answer: she will give the way in the spring, when the sea opens, on the day before we sail and not before. A route told in winter, she said, is a route a man rehearses all winter and fears all winter, and comes to with his nerve spent. The crew should hear only what they need, on the day.

That is either good counsel or another delay put kindly. I cannot tell which, and I have stopped pretending I can.

Set a day: the first steady north wind ([[knowledge/boreas]]) after the Pleiades ([[knowledge/pleiades]]) rise in the morning. She agreed.

- [x] Ask Circe for the route
- [x] Name the day, by its sign
- [ ] Prepare the ship to be ready on that sign, not after it

**Decision:** sail on the sign ([[decisions/wait-out-the-seasons]]). Have everything stowed before it comes.

See [[people/circe]]. Leg: [[voyage/legs/aeaea-return]]. Part of [[voyage/_index]].`,
    links: ["people/circe.md", "voyage/legs/aeaea-return.md", "voyage/_index.md", "knowledge/boreas.md", "knowledge/pleiades.md", "decisions/wait-out-the-seasons.md"],
    fields: { day: 892, place: "Aeaea", wind: "north", aboard: 37 },
  },
  {
    path: "voyage/day-1038-circes-route.md",
    title: "Day 1,038 -- Circe gives the route",
    type: "log",
    created: "2019-05-16",
    updated: "2019-05-16",
    status: "filed",
    tags: ["log", "route", "aeaea"],
    people: ["person:circe"],
    places: ["place:aeaea", "place:sirens", "place:scylla", "place:charybdis", "place:thrinacia"],
    summary: "The night before sailing she took my hand, led me apart from the crew, and gave the whole route in order. Written down while she spoke.",
    body: `**Position:** Aeaea. Ship down and loaded.
**Wind:** north, steady since yesterday. The sign.
**Sea:** slight.
**Aboard:** 37, sleeping by the ship.

She took me apart from the others and asked for the whole story of the dead, and then gave the route. In order, as she said it:

1. **The Sirens.** Wax in the crew's ears. If I want to hear, tied to the mast, hand and foot; if I order release, more rope. [[knowledge/sirens]]
2. **Two ways after.** The Wandering Rocks, which only one ship has ever passed. Or the strait. [[knowledge/wandering-rocks]]
3. **The strait.** Scylla on one side, high in her cave, six heads; she takes six men, one in each mouth. Charybdis on the other, under a fig tree, drinking the sea three times a day. Keep to Scylla: better to lose six than all. Do not stop to fight. [[knowledge/scylla]], [[knowledge/charybdis]], [[decisions/scylla-or-charybdis]]
4. **Thrinacia.** The cattle and sheep of Helios. Seven herds of cattle, seven flocks of sheep, fifty to each. If they are left unharmed, you may reach Ithaca. If harmed, destruction for the ship and the crew; and you, if you escape, late and badly, having lost every companion. [[knowledge/thrinacia-cattle]]

The fourth item matches Teiresias word for word.

**Decision:** sail at dawn. Tell the crew items 1 and 4. Not item 3 ([[decisions/what-to-tell-the-crew]]).

See [[people/circe]], [[knowledge/teiresias-forecast]]. Leg: [[voyage/legs/aeaea-return]]. Part of [[voyage/_index]].`,
    links: ["knowledge/sirens.md", "knowledge/scylla.md", "knowledge/charybdis.md", "people/circe.md", "knowledge/teiresias-forecast.md", "voyage/legs/aeaea-return.md", "voyage/_index.md", "knowledge/wandering-rocks.md", "decisions/scylla-or-charybdis.md", "knowledge/thrinacia-cattle.md", "decisions/what-to-tell-the-crew.md"],
    fields: { day: 1038, place: "Aeaea", wind: "north", aboard: 37, source: "Circe" },
  },
  {
    path: "voyage/day-1039-leaving-aeaea.md",
    title: "Day 1,039 -- leaving Aeaea",
    type: "log",
    created: "2019-05-17",
    updated: "2019-05-17",
    status: "filed",
    tags: ["log", "aeaea", "route"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "Away at dawn, every man counted at the waterline. Circe sent a following wind. Seven hundred and eighty-one days on the island, all told.",
    body: `**Position:** Aeaea, standing out; by dusk well clear to the south-east.
**Wind:** fair following wind, sent by Circe.
**Sea:** slight.
**Aboard:** 37 and myself. Counted at the waterline, twice.

Dawn. Circe went up the island. The crew went aboard, sat in order, struck the water with the oars.

The rule from day 611: count heads at every embarkation ([[crew/standing-orders]]). Done. Thirty-seven.

She sent a wind behind the ship that filled the sail, a good companion. We set the tackle and sat, and let the wind and the steersman keep her course.

Told the crew, as decided ([[decisions/what-to-tell-the-crew]]): the Sirens first, and what to do. The island of the sun afterwards, and the oath they would be asked to keep. Not the strait.

All told, seven hundred and eighty-one days on Aeaea across both stays. Written out so it cannot shrink in the memory.

**Decision:** course for the Sirens. Wax ready, rope ready.

See [[people/circe]]. Leg: [[voyage/legs/sirens]]. Part of [[voyage/_index]].`,
    links: ["people/circe.md", "voyage/legs/sirens.md", "voyage/_index.md", "crew/standing-orders.md", "decisions/what-to-tell-the-crew.md"],
    fields: { day: 1039, place: "Aeaea", wind: "following", aboard: 37 },
  },
  {
    path: "voyage/day-1040-eve-of-the-sirens.md",
    title: "Day 1,040 -- the eve of the Sirens",
    type: "log",
    created: "2019-05-18",
    updated: "2019-05-18",
    status: "filed",
    tags: ["log", "sirens", "plan"],
    places: ["place:sirens"],
    summary: "The night before the Sirens. Wax cut, rope coiled, the order of the morning written out and read to the crew twice.",
    body: `**Position:** open water, north-west of the Sirens' island by the pilot's reckoning.
**Wind:** following, moderate.
**Sea:** slight.
**Aboard:** 37.

Tomorrow's order, written out and read aloud to the crew twice, so that it is theirs and not only mine:

1. When the island is in sight, the sail comes down.
2. Every man's ears are sealed with wax. I do it myself, one at a time.
3. I am tied upright to the mast-step, hands and feet, the rope's ends made fast to the mast.
4. Row. Do not look at me.
5. If I give any order at all, [[crew/perimedes]] and Eurylochus add rope. Any order. [[oaths/sirens-binding-order]]
6. Wax comes out only when I nod, and only once the island is astern and out of hearing.

- [x] Wheel of wax cut into thirty-seven pieces ([[crew/sirens-wax]])
- [x] Rope: two coils, checked
- [x] Perimedes and Eurylochus told items 5 and 6 separately

The crew asked whether I need to hear it. I said yes ([[decisions/hear-the-sirens]]). Circe said I could, if I was bound. A plan that allows the one risk on purpose is better than one that pretends there is none.

**Decision:** as written above. No discretion on the day.

See [[knowledge/sirens]]. Tomorrow: [[voyage/day-1041-sirens]]. Leg: [[voyage/legs/sirens]]. Part of [[voyage/_index]].`,
    links: ["knowledge/sirens.md", "voyage/day-1041-sirens.md", "voyage/legs/sirens.md", "voyage/_index.md", "crew/perimedes.md", "oaths/sirens-binding-order.md", "crew/sirens-wax.md", "decisions/hear-the-sirens.md"],
    fields: { day: 1040, place: "approaching the Sirens", wind: "following", aboard: 37 },
  },
  {
    path: "voyage/day-1044-thrinacia-landfall.md",
    title: "Day 1,044 -- Thrinacia",
    type: "log",
    created: "2019-05-22",
    updated: "2019-05-22",
    status: "filed",
    tags: ["log", "oath", "helios"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Heard the cattle lowing before we saw the island. I said row past. Eurylochus said the men could not, and they sided with him. The oath first.",
    body: `**Position:** Thrinacia, the island of the sun. Beached in a hollow harbour with fresh water.
**Wind:** light, then south.
**Sea:** slight.
**Aboard:** 31, the night after the strait.

Before we saw the island we heard the cattle lowing and the sheep bleating as they were driven in. I told the crew, with a heavy heart, what Teiresias and Circe had both said: avoid the island of the sun. Row past.

[[crew/eurylochus]] answered for all of them. They were beaten and grieving, he said, and could not row through a night after the strait. Let them land, eat, sleep, and go on at dawn. The rest agreed with him at once ([[crew/dissent-log]]).

I said: then swear. Every man. If we find a herd of cattle or a flock of sheep, no one kills a single animal. Eat what Circe gave.

They swore, all of them, the full oath: [[oaths/helios]] ([[crew/oath-signatories]]).

We beached and ate and grieved for the six. Then slept.

In the third watch Zeus sent a gale from the south.

**Decision:** landed against my judgement ([[decisions/land-on-thrinacia]]). Oath sworn before the keel touched.

Journal: [[journal/day-1044]]. Leg: [[voyage/legs/thrinacia]]. Part of [[voyage/_index]].`,
    links: ["crew/eurylochus.md", "oaths/helios.md", "voyage/legs/thrinacia.md", "voyage/_index.md", "crew/dissent-log.md", "crew/oath-signatories.md", "decisions/land-on-thrinacia.md", "journal/day-1044.md"],
    fields: { day: 1044, place: "Thrinacia", wind: "south", aboard: 31 },
  },
  {
    path: "voyage/day-1050-wind-still-south.md",
    title: "Day 1,050 -- wind still south",
    type: "log",
    created: "2019-05-28",
    updated: "2019-05-28",
    status: "filed",
    tags: ["log", "weather", "helios"],
    places: ["place:thrinacia"],
    summary: "Sixth day of a south wind. The ship dragged into a cave. Reminded the crew of the oath at the evening meal.",
    body: `**Position:** Thrinacia, ship hauled into a sea-cave above the beach.
**Wind:** south, strong. Has not changed in six days.
**Sea:** rough.
**Aboard:** 31.

Six days of the same wind ([[knowledge/notus]]). Hauled the ship into a cave where the nymphs have their seats and dancing floors, out of the weather.

Called the crew together at the evening meal and said it again: there is food and drink in the ship. Keep your hands off the cattle, or we will suffer. These are the cattle of a terrible god, [[people/helios]], who sees everything and hears everything.

They agreed. They are still eating from Circe's stores ([[crew/thrinacia-provisions]]), and there is no hardship yet to test them.

Wind log since landing:

| Day | Wind |
|---|---|
| 1044 | south, rising at night |
| 1045 | south, gale |
| 1046 | south, gale |
| 1047 | south-east |
| 1048 | south |
| 1049 | south |
| 1050 | south |

**Decision:** wait for a north wind. Remind the crew of the oath every evening.

See [[oaths/helios]]. Leg: [[voyage/legs/thrinacia]]. Part of [[voyage/_index]].`,
    links: ["oaths/helios.md", "voyage/legs/thrinacia.md", "voyage/_index.md", "knowledge/notus.md", "people/helios.md", "crew/thrinacia-provisions.md"],
    fields: { day: 1050, place: "Thrinacia", wind: "south", aboard: 31 },
  },
  {
    path: "voyage/day-1062-stores-out.md",
    title: "Day 1,062 -- stores out",
    type: "log",
    created: "2019-06-09",
    updated: "2019-06-09",
    status: "filed",
    tags: ["log", "stores", "helios"],
    places: ["place:thrinacia"],
    summary: "The last of Circe's grain and wine gone. The men fish with bent hooks and snare whatever birds they can catch. The herds graze in plain sight.",
    body: `**Position:** Thrinacia.
**Wind:** south and east, alternating. Never north, never west.
**Sea:** moderate.
**Aboard:** 31.

Eighteen days. The stores Circe put aboard ([[crew/thrinacia-provisions]]) are finished: the last grain this morning, the last wine three days ago.

The men have gone to the rocks with bent hooks, and they set snares for birds, anything that comes to hand. Hunger is at their bellies.

The herds of the sun graze along the shore and the meadows above it, every day, in plain sight. Seven herds and seven flocks, fifty to each ([[knowledge/thrinacia-cattle]]). Nobody has touched one. Nobody has said anything about them either, which I do not like.

- [x] Last of the stores shared out evenly
- [x] Fishing parties: three, in rotation
- [ ] Find out what grows on the island that is not the god's

The crew are thin, and quiet. Eurylochus is quiet too.

**Decision:** hold the camp and fish. If the wind has not changed when the fishing fails, I go inland alone to pray to the gods for a way off this island, and Eurylochus keeps the camp.

See [[decisions/cattle-of-helios]]. Leg: [[voyage/legs/thrinacia]]. Part of [[voyage/_index]].`,
    links: ["decisions/cattle-of-helios.md", "voyage/legs/thrinacia.md", "voyage/_index.md", "crew/thrinacia-provisions.md", "knowledge/thrinacia-cattle.md"],
    fields: { day: 1062, place: "Thrinacia", wind: "south-east", aboard: 31 },
  },
  {
    path: "voyage/day-1077-the-cattle.md",
    title: "Day 1,077 -- the cattle",
    type: "log",
    created: "2019-06-24",
    updated: "2019-06-24",
    status: "filed",
    tags: ["log", "helios", "oath"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Inland to pray, out of the wind, and the gods poured sleep over my eyes. I woke to the smell of roasting meat.",
    body: `**Position:** Thrinacia. Inland, then the camp.
**Wind:** south-east.
**Sea:** moderate.
**Aboard:** 31.

Went up the island to pray, found a place sheltered from the wind, washed my hands, and prayed to all the gods on Olympos. They poured sweet sleep on my eyelids ([[studies/sleep-on-a-single-hand-crossing]]).

While I slept, as the men told it afterwards, Eurylochus spoke to the crew:

> All deaths are hateful, but the worst is to die of hunger. Come, let us drive off the best of the cattle of Helios and sacrifice them to the gods. If we reach Ithaca we will build him a rich temple. And if he wants the ship, I would rather lose my life once, gulping the sea, than waste away on a desert island.

They agreed. They drove the best of the herd ([[knowledge/thrinacia-cattle]]) from close by, prayed, cut their throats, and had no barley, so used oak leaves; and no wine, so poured water ([[knowledge/sacrifice-procedure]]).

I woke and went down, and halfway to the ship the smell of the fat reached me.

Nothing can be undone. The oath is broken by every man.

**Decision:** none available. Recorded in full in [[decisions/cattle-of-helios]].

See [[oaths/helios]], [[crew/eurylochus]]. Leg: [[voyage/legs/thrinacia]]. Part of [[voyage/_index]].`,
    links: ["decisions/cattle-of-helios.md", "oaths/helios.md", "crew/eurylochus.md", "voyage/legs/thrinacia.md", "voyage/_index.md", "studies/sleep-on-a-single-hand-crossing.md", "knowledge/thrinacia-cattle.md", "knowledge/sacrifice-procedure.md"],
    fields: { day: 1077, place: "Thrinacia", wind: "south-east", aboard: 31 },
  },
  {
    path: "voyage/day-1083-sixth-day.md",
    title: "Day 1,083 -- the sixth day of feasting",
    type: "log",
    created: "2019-06-30",
    updated: "2019-06-30",
    status: "filed",
    tags: ["log", "helios", "omens"],
    places: ["place:thrinacia"],
    summary: "Six days they have feasted. The hides crawl, the meat lows on the spits. Tonight the wind dropped.",
    body: `**Position:** Thrinacia.
**Wind:** south-east all day; dropping at dusk.
**Sea:** falling.
**Aboard:** 31.

Six days. The crew drive off the best of the cattle each day and eat. I do not.

The gods have shown signs, and they are written here as observed, not interpreted:

- The hides crawl on the ground ([[omens/day-1078-hides-crawled]]).
- The meat on the spits, raw and roasted, lows like cattle.

The crew see these too. They keep eating.

I have upbraided each man, one after another. There is no remedy. The cattle are dead.

At dusk the wind fell, and for the first time since we landed it began to back towards the north.

- [ ] Ship out of the cave at first light
- [ ] Water aboard
- [ ] Count heads at the waterline ([[crew/roll-calls/day-1084]])

**Decision:** sail at dawn. There is nothing here to stay for and nothing to be gained by leaving, and only one of those is a reason.

See [[decisions/cattle-of-helios]]. Leg: [[voyage/legs/thrinacia]]. Part of [[voyage/_index]].`,
    links: ["decisions/cattle-of-helios.md", "voyage/legs/thrinacia.md", "voyage/_index.md", "omens/day-1078-hides-crawled.md", "crew/roll-calls/day-1084.md"],
    fields: { day: 1083, place: "Thrinacia", wind: "south-east, dropping", aboard: 31 },
  },
  {
    path: "voyage/day-1084-the-storm.md",
    title: "Day 1,084 -- the storm",
    type: "log",
    created: "2019-07-01",
    updated: "2019-07-12",
    status: "filed",
    tags: ["log", "wreck", "losses"],
    places: ["place:thrinacia"],
    summary: "Out of sight of land, a cloud over the ship, a west wind, the mast down, the bolt. Every man in the water and none came up. Written later.",
    body: `**Position:** open sea, out of sight of Thrinacia.
**Wind:** fair at dawn; then a west gale out of a clear sky.
**Sea:** very rough.
**Aboard:** 31 at dawn. 0 at dusk.

Written on Ogygia, eleven days later, from memory. The log aboard went down with the ship.

Launched at dawn. Thirty-one counted at the waterline ([[crew/roll-calls/day-1084]]). Raised the mast and sail.

When the island was out of sight and there was only sky and sea, Zeus set a dark cloud over the ship, and the sea went dark under it. She ran on a short while.

Then the west wind came screaming. The gust snapped both forestays together ([[knowledge/mast-stepping]]). The mast fell back into the hold and the tackle with it. In the stern the mast struck the steersman on the head and smashed his skull, and he went off the deck like a diver.

Then Zeus thundered, and struck the ship with lightning ([[omens/day-1084-thunder]]). She spun, filled with sulphur, and the men were thrown into the sea. They were carried on the waves round the hull like sea-birds, and the god took away their homecoming.

Thirty-one ([[crew/losses/thrinacia]]). None came up near me.

**Decision:** lashed the mast to the keel with the backstay of ox-hide. Sat on them.

See [[crew/_index]]. Leg: [[voyage/legs/the-wreck-and-charybdis]]. Part of [[voyage/_index]].`,
    links: ["crew/_index.md", "voyage/legs/the-wreck-and-charybdis.md", "voyage/_index.md", "crew/roll-calls/day-1084.md", "knowledge/mast-stepping.md", "omens/day-1084-thunder.md", "crew/losses/thrinacia.md"],
    fields: { day: 1084, place: "off Thrinacia", wind: "west gale", aboard: 0, lost: 31 },
  },
  {
    path: "voyage/day-1085-the-fig-tree.md",
    title: "Day 1,085 -- the fig tree",
    type: "log",
    created: "2019-07-02",
    updated: "2019-07-12",
    status: "filed",
    tags: ["log", "charybdis", "hazard"],
    places: ["place:charybdis"],
    summary: "A south wind all night carried me back to the strait. Charybdis drawing in. Caught the fig tree and hung there until she gave the timbers back.",
    body: `**Position:** the strait, Charybdis's side.
**Wind:** south, all night.
**Sea:** the strait's.
**Aboard:** myself, on a mast and a keel.

Written on Ogygia, from memory.

The west wind dropped and a south wind ([[knowledge/notus]]) came, which was the worst wind it could have been: it carried me back the whole night to the strait. At sunrise I was at Scylla's rock and the dread of Charybdis.

She was sucking down the salt sea. I was thrown up high and caught hold of the tall fig tree above her and clung to it like a bat ([[decisions/hold-the-fig-tree]]). There was nowhere to set my feet and no way to climb up: the roots were far below and the branches far above, long and large, shading her.

I held on, waiting for her to give back the mast and keel. They came, late. About the hour a man gets up from judging disputes for his supper, the timbers appeared.

I let go my hands and feet and fell into the water beside them, sat on them, and paddled with my hands.

Scylla did not see me. The Father of gods and men ([[people/zeus]]) did not let her.

**Decision:** away from the strait, on the current, whatever it brings.

See [[knowledge/charybdis]], [[knowledge/scylla]]. Leg: [[voyage/legs/the-wreck-and-charybdis]]. Part of [[voyage/_index]].`,
    links: ["knowledge/charybdis.md", "knowledge/scylla.md", "voyage/legs/the-wreck-and-charybdis.md", "voyage/_index.md", "knowledge/notus.md", "decisions/hold-the-fig-tree.md", "people/zeus.md"],
    fields: { day: 1085, place: "Charybdis", wind: "south", aboard: 0 },
  },
  {
    path: "voyage/day-1088-adrift.md",
    title: "Day 1,088 -- adrift",
    type: "log",
    created: "2019-07-05",
    updated: "2019-07-12",
    status: "filed",
    tags: ["log", "adrift"],
    places: ["place:charybdis", "place:ogygia"],
    summary: "Third day on the timbers. No land, no sail, no water but what fell on the wood. Counting days on my fingers.",
    body: `**Position:** open sea, south and west of the strait, probably. No way to know.
**Wind:** light, variable.
**Sea:** slight swell.
**Aboard:** myself.

Written on Ogygia from memory, with the day counts as I kept them on my fingers.

Third day. The mast and keel are still lashed. The ox-hide backstay has held. My hands are raw from the knots and from paddling.

There is no water but dew in the early hours, licked off the wood. There is no food. The sun is the worst of it at noon ([[knowledge/fevers]]).

What I kept doing, because it was the only thing to do:

- Check the lashings at dawn and dusk.
- Keep one hand on the wood when sleeping.
- Count the days. Do not lose the count.

I thought about the thirty-one a great deal, and the eleven ships before them. I thought about the ledger ([[crew/fleet-strength]]), and that I am the only entry on it now that is still open.

**Decision:** stay on the wood. No other option exists, but it is still a decision, and it is written down so that it is mine.

Journal: [[journal/day-1090]]. Leg: [[voyage/legs/drift-to-ogygia]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/drift-to-ogygia.md", "voyage/_index.md", "knowledge/fevers.md", "crew/fleet-strength.md", "journal/day-1090.md"],
    fields: { day: 1088, place: "open sea", wind: "variable", aboard: 0 },
  },
  {
    path: "voyage/day-1092-adrift.md",
    title: "Day 1,092 -- adrift, the seventh day",
    type: "log",
    created: "2019-07-09",
    updated: "2019-07-12",
    status: "filed",
    tags: ["log", "adrift"],
    places: ["place:ogygia"],
    summary: "Seventh day. Rain on the fourth saved me. Birds overhead today, working the water, which means land within some days of here.",
    body: `**Position:** open sea. Further south, I think, by the sun.
**Wind:** light westerly.
**Sea:** slight.
**Aboard:** myself.

Written on Ogygia, from memory.

Seventh day by the count. The rain on the fourth day saved me; I drank from the hollow of the keel until I was sick, and then more slowly ([[knowledge/fevers]]).

Today, birds overhead. Shearwaters, working low over the water, diving and resting on the swell. They do not go far from land to roost ([[studies/signs-of-land]]). Land somewhere within some days of here, then, though not in sight.

Weak. Hard to keep my hands closed on the lashings in the afternoon heat.

Things I have promised, written in my head since I have nothing to write on:

1. If I reach any shore, the count goes into the log before anything else ([[crew/roll-calls/day-1095]]).
2. The crew's names go into the ledger, every one I know.
3. The return is still the goal. It does not change because the means have.

**Decision:** follow the birds, as far as a man on a keel can follow anything.

Leg: [[voyage/legs/drift-to-ogygia]]. Goal: [[goals/return-to-ithaca]]. Part of [[voyage/_index]].`,
    links: ["voyage/legs/drift-to-ogygia.md", "goals/return-to-ithaca.md", "voyage/_index.md", "knowledge/fevers.md", "studies/signs-of-land.md", "crew/roll-calls/day-1095.md"],
    fields: { day: 1092, place: "open sea", wind: "light west", aboard: 0 },
  },
  {
    path: "voyage/day-1095-ogygia.md",
    title: "Day 1,095 -- Ogygia",
    type: "log",
    created: "2019-07-12",
    updated: "2026-07-12",
    status: "filed",
    tags: ["log", "ogygia", "landfall"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "On the tenth night the gods brought me to Ogygia. Calypso took me in. The first entry in seven years written in a dry place.",
    body: `**Position:** Ogygia. A beach below a cave.
**Wind:** light onshore.
**Sea:** slight, a long swell on the sand.
**Aboard:** myself. The timbers went back out with the tide.

Ninth day adrift, tenth night. In the dark the gods brought me in to Ogygia, where Calypso lives, the goddess with the lovely hair. I did not see the shore until I was on it.

She found me, took me in, and cared for me. That is the whole account and it should stay plain.

The count, as promised to myself on day 1092, before anything else ([[crew/roll-calls/day-1095]]):

| | Ships | Crew |
|---|---|---|
| Out of Troy, day 3 | 12 | 600 |
| Landfall Ogygia, day 1095 | 0 | 0 |
| Survivors | | myself |

Three years since Troy fell. One summer budgeted for the voyage home.

*Annotated day 3652:* the stay that began here ([[ogygia/years/year-1]]) has lasted seven years, 2,557 days. The raft is built. Launch is planned for today and has not happened as this line is written.

**Decision:** recover. Then find a way off.

See [[people/calypso]], [[ogygia/island/day-1095-landfall]], [[journal/day-1095]], [[ogygia/_index]], [[voyage/ogygia/_index]]. Leg: [[voyage/legs/drift-to-ogygia]]. Part of [[voyage/_index]].`,
    links: ["people/calypso.md", "ogygia/_index.md", "voyage/ogygia/_index.md", "voyage/legs/drift-to-ogygia.md", "voyage/_index.md", "crew/roll-calls/day-1095.md", "ogygia/years/year-1.md", "ogygia/island/day-1095-landfall.md", "journal/day-1095.md"],
    fields: { day: 1095, place: "Ogygia", wind: "light onshore", aboard: 0 },
  },
];
