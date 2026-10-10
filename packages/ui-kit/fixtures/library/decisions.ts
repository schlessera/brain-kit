// Library domain: decisions. See ../README.md and ./types.ts.
//
// Three folders kept side by side because they answer to each other: the
// choices made between Troy and the beach at Ogygia, the oaths sworn and owed
// along the way, and the signs observed, with whether each one held. Omens
// with a day in the path are created on that day; birds are described by what
// they were doing.

import type { LibraryDocument } from "./types.js";

export const decisionsDocuments: LibraryDocument[] = [
  // ---------------------------------------------------------------- decisions
  {
    path: "decisions/raid-ismarus.md",
    title: "Raid Ismarus",
    type: "decision",
    created: "2016-07-21",
    updated: "2016-07-22",
    status: "closed",
    tags: ["decision", "crew", "ismarus"],
    places: ["place:ismarus"],
    summary: "First landfall out of Troy. Took the town of the Cicones, shared the goods evenly, and gave the order to leave the same day.",
    body: `The fleet was nine days out of Troy, twelve ships and six hundred men, with stores for a short passage and a war's habits still in every man aboard. The Cicones held Ismarus and had fought on the other side.

| Option | For | Against |
| --- | --- | --- |
| Sail past | No risk, no delay | Thin stores; crew expecting a share |
| Raid the town | Stores, plunder, a fair division | The country behind it is not empty |
| Trade | Peaceful | Nothing to trade but what we took at Troy |

**Chosen:** raid, then leave at once. The town fell quickly. The goods were divided so that no man went short of his share, and the priest of Apollo, [[people/maron]], was spared (see [[decisions/spare-maron]]).

**Cost:** nothing on the day itself. The cost came the next morning and belongs to a different decision: [[decisions/stay-the-night-at-ismarus]].

**Consequence:** stores for the passage, and twelve jars of a wine strong enough to matter later ([[crew/ismarus-wine-ration]]).

The day itself is logged at [[voyage/day-9-ismarus]].

## Questions retained

- [ ] Was the raid needed at all, or only expected?
- [ ] Would the order to leave have held if it had been given before the division rather than after?

Filed under [[decisions/_index]].`,
    links: ["decisions/spare-maron.md", "decisions/stay-the-night-at-ismarus.md", "decisions/_index.md", "people/maron.md", "crew/ismarus-wine-ration.md", "voyage/day-9-ismarus.md"],
    fields: { day: 9, place: "Ismarus", cost: "none on the day" },
  },
  {
    path: "decisions/stay-the-night-at-ismarus.md",
    title: "Stay the night at Ismarus",
    type: "decision",
    created: "2016-07-21",
    updated: "2016-07-22",
    status: "closed",
    tags: ["decision", "crew", "ismarus", "losses"],
    places: ["place:ismarus"],
    summary: "My order was to sail that evening. The crew outvoted it with the wine still open. Seventy-two men, six from each ship, by noon.",
    body: `Recorded because it is the first time the order was given and not followed, and it set the pattern.

I told the crew to put to sea the same evening, before the Cicones inland could be raised. The men would not leave the beach. There was wine, there were sheep and cattle to slaughter, and the town was taken; nobody saw a reason to hurry.

| Option | Who wanted it |
| --- | --- |
| Sail at dusk | Me |
| Stay, feast, sail at first light | Everyone else |

**Chosen (not by me):** stay.

The Cicones came down from the inland country at dawn, mounted and on foot, more of them than there are leaves in spring. We held them by the ships until the afternoon and then broke.

**Cost:** 72 men ([[crew/losses/ismarus]]). Six from each of the twelve ships, as if it had been counted out. The ledger line for this landfall reads "would not leave the wine", and I have left it in those words.

**Consequence:** every ship sailed six short. We called each man's name three times from the beach before we went, as is owed ([[voyage/day-10-ismarus-morning-after]]).

## Questions retained

- [ ] Should an order that the whole crew refuses still be given, or does giving it and losing teach the wrong lesson to both sides?
- [ ] Six from each ship is too even. Was it chance?

See [[decisions/raid-ismarus]], [[journal/day-10]] and [[crew/_index]]; filed under [[decisions/_index]].`,
    links: ["decisions/raid-ismarus.md", "crew/_index.md", "decisions/_index.md", "crew/losses/ismarus.md", "voyage/day-10-ismarus-morning-after.md", "journal/day-10.md"],
    fields: { day: 9, place: "Ismarus", cost: "72 men", source: "crew vote" },
  },
  {
    path: "decisions/spare-maron.md",
    title: "Spare Maron, priest of Apollo",
    type: "decision",
    created: "2016-07-21",
    updated: "2016-10-18",
    status: "settled",
    tags: ["decision", "gods", "ismarus"],
    places: ["place:ismarus"],
    summary: "Spared the priest, his wife and his child in the god's grove at Ismarus. He paid in wine, and the wine paid for the cave.",
    body: `[[people/maron]], son of Euanthes, kept the grove of Apollo at Ismarus and lived in it with his wife and child. In a taken town that is not much protection.

**Options:** treat the grove like the rest of the town, or leave it untouched out of respect for the god who holds it.

**Chosen:** leave it untouched and set a guard on the household.

Maron gave guest-gifts in return: seven talents of worked gold, a mixing bowl of solid silver, and twelve jars of sweet unmixed wine, so strong it is cut with twenty measures of water and still fills the room ([[crew/ismarus-wine-ration]]). He kept its existence from his own servants. The arrangement is recorded as a pledge at [[oaths/maron-guest-gift]].

**Cost:** one household not taken. Nothing else.

**Consequence:** this is the wine carried into the cave of [[people/polyphemus]] on day 97, and the wine that put him down on day 98 ([[voyage/day-98-the-stake]]). Of every decision on this list, it is the only one whose return was larger than its price, and I did not know that at the time.

## Questions retained

- [ ] Would I have spared him without the god? Be honest in the answer.

Filed under [[decisions/_index]].`,
    links: ["oaths/maron-guest-gift.md", "people/polyphemus.md", "decisions/_index.md", "people/maron.md", "crew/ismarus-wine-ration.md", "voyage/day-98-the-stake.md"],
    fields: { day: 9, place: "Ismarus", cost: "none", source: "Maron" },
  },
  {
    path: "decisions/drag-back-the-lotus-eaters.md",
    title: "Drag the lotus-eaters back to the ships",
    type: "decision",
    created: "2016-08-11",
    updated: "2016-08-11",
    status: "closed",
    tags: ["decision", "crew", "lotus"],
    places: ["place:lotus"],
    summary: "Three men ate the lotus and lost the wish to go home. Carried them back weeping and tied them under the benches. No losses.",
    body: `After nine days driven off course from Cape Malea we made land and sent three men inland to learn who lived there. The people gave them the lotus to eat ([[knowledge/lotus]]). They meant no harm by it. The three men stopped wanting anything but to stay and eat more of it, and forgot the voyage altogether.

| Option | Cost |
| --- | --- |
| Leave them | Three men, and a precedent |
| Wait until it wears off | Nobody could say it would |
| Bring them back by force | Their goodwill, for a time |

**Chosen:** force. I went up myself, we carried them down to the ships weeping, and lashed them under the rowing benches. Then I ordered everyone else aboard before any more of them tasted it, and we put out the same hour.

**Cost:** none. All three lived and rowed again.

**Consequence:** the first rule written into the brain about the crew ([[crew/standing-orders]]): *no man eats what the country offers until it is known what it does.* It was kept on Aeaea and broken on Thrinacia, in that order.

## Questions retained

- [ ] They were not unhappy. Is that a reason to have left them? I have thought about it more on Ogygia than I did on the beach.

See [[crew/lotus-eaters]], [[voyage/day-30-lotus-eaters]] and [[crew/_index]]. Filed under [[decisions/_index]].`,
    links: ["crew/_index.md", "decisions/_index.md", "knowledge/lotus.md", "crew/standing-orders.md", "crew/lotus-eaters.md", "voyage/day-30-lotus-eaters.md"],
    fields: { day: 30, place: "Land of the Lotus-eaters", cost: "none" },
  },
  {
    path: "decisions/enter-the-cave.md",
    title: "Enter the cave",
    type: "decision",
    created: "2016-10-17",
    updated: "2016-10-19",
    status: "closed",
    tags: ["decision", "cyclopes", "crew", "losses"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Took twelve men and a skin of Maron's wine to see who lived in the cave across the water. The crew wanted the cheeses and the lambs and a quick exit.",
    body: `Ship 1 crossed from the goat island ([[voyage/day-96-goat-island]]) to the mainland of the Cyclopes to find out what kind of people lived there. I took twelve of the best men ([[crew/cave-party]]) and a skin of the wine from [[decisions/spare-maron]].

The cave was empty when we reached it: pens of lambs and kids, racks of cheeses, pails of whey.

> "Take the cheeses, drive the lambs down to the ship, and go." — the crew, unanimously

| Option | Upside | Downside |
| --- | --- | --- |
| Take and go | Stores; no meeting | Theft from a stranger |
| Wait for the owner | Guest-gifts; knowledge of the country | Unknown owner |

**Chosen:** wait. See the follow-on at [[decisions/wait-for-polyphemus]]; the two were one choice made twice.

**Cost:** 6 men from ship 1, two at a time, over two days ([[crew/losses/cyclopes]]).

**Consequence:** the cave, the name, and the ten years since. The men were right and I overruled them, which is the reverse of [[decisions/stay-the-night-at-ismarus]].

## Questions retained

- [ ] Curiosity or the guest-gifts: which was it really?
- [ ] Twelve men was too many to risk and too few to fight. Why twelve?

Filed under [[decisions/_index]].`,
    links: ["decisions/spare-maron.md", "decisions/wait-for-polyphemus.md", "decisions/stay-the-night-at-ismarus.md", "decisions/_index.md", "voyage/day-96-goat-island.md", "crew/cave-party.md", "crew/losses/cyclopes.md"],
    fields: { day: 97, place: "Land of the Cyclopes", cost: "6 men" },
  },
  {
    path: "decisions/wait-for-polyphemus.md",
    title: "Wait for the owner of the cave",
    type: "decision",
    created: "2016-10-17",
    updated: "2016-10-19",
    status: "closed",
    tags: ["decision", "cyclopes", "guest-right"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes", "place:aeolia"],
    summary: "Stayed to claim guest-right from a host who did not recognise it. He rolled a stone across the door that twelve men could not shift.",
    body: `We lit a fire, made an offering, ate some of his cheese, and waited. I expected a host. The law of guests ([[knowledge/guest-friendship]]) is old and I assumed it was everywhere.

He came in at evening with his flocks and a load of dry wood, and set a stone in the doorway that twenty-two wagons could not have moved ([[knowledge/cyclops-door-stone]]). Then he saw us.

**What I relied on:** guest-right, under Zeus who protects strangers. I said so to his face. He answered that his people take no notice of Zeus ([[knowledge/cyclopes-customs]]), and ate two of the men. The claim is logged at [[oaths/xenia-polyphemus]], standing *refused*.

**Cost:** counted under [[decisions/enter-the-cave]]: 6 men in all.

**What it closed off:** killing him in his sleep that first night. I had the sword at his side before I thought it through. Nobody but him could move the stone. That reasoning is at [[decisions/blind-rather-than-kill]].

## Questions retained

- [ ] How many places on the route since have I assumed the law of guests held, and been right only by luck? Aeolus kept it ([[oaths/xenia-aeolus]]); Circe did not, at first.
- [ ] Is there a way to test a host before entering the house?

Filed under [[decisions/_index]].`,
    links: ["oaths/xenia-polyphemus.md", "decisions/enter-the-cave.md", "decisions/blind-rather-than-kill.md", "oaths/xenia-aeolus.md", "decisions/_index.md", "knowledge/guest-friendship.md", "knowledge/cyclops-door-stone.md", "knowledge/cyclopes-customs.md"],
    fields: { day: 97, place: "Land of the Cyclopes", cost: "counted under entering the cave" },
  },
  {
    path: "decisions/nobody-as-the-name.md",
    title: "Give the name as Nobody",
    type: "decision",
    created: "2016-10-18",
    updated: "2016-10-19",
    status: "closed",
    tags: ["decision", "cyclopes", "name"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Asked my name over the third bowl of wine, I said Nobody. When his neighbours came to the door he told them Nobody was killing him, and they went home.",
    body: `He asked my name once he had drunk three bowls of Maron's wine ([[crew/ismarus-wine-ration]]), and promised me a guest-gift for it: he would eat me last.

| Option | Effect |
| --- | --- |
| The true name | Any neighbour who came would know whom to hunt |
| A false ordinary name | Same, for a different man |
| *Nobody* | A cry for help that reports nothing |

**Chosen:** Nobody. Written down beforehand as a standing rule: [[notes/do-not-give-my-name]].

It worked exactly as intended. When the other Cyclopes came to the stone at his shouting and asked who was harming him, he told them Nobody was. They told him to pray to his father if he was ill, and left.

**Cost:** none, while it held.

**Consequence:** it held until I broke it myself from the ship. The breach is a separate record, [[decisions/name-at-the-stern]], and it is the more expensive of the two by ten years.

## Questions retained

- [ ] The rule was right and I wrote it down. What would have made me keep it at the stern? Writing it down did not.

Related: [[voyage/day-98-the-stake]] and [[people/polyphemus]]. Filed under [[decisions/_index]].`,
    links: ["notes/do-not-give-my-name.md", "decisions/name-at-the-stern.md", "decisions/_index.md", "crew/ismarus-wine-ration.md", "voyage/day-98-the-stake.md", "people/polyphemus.md"],
    fields: { day: 98, place: "Land of the Cyclopes", cost: "none until reversed" },
  },
  {
    path: "decisions/blind-rather-than-kill.md",
    title: "Blind him rather than kill him",
    type: "decision",
    created: "2016-10-17",
    updated: "2016-10-19",
    status: "closed",
    tags: ["decision", "cyclopes", "poseidon"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes"],
    summary: "A dead Cyclops leaves us sealed behind a stone nobody else can move. A blind one still opens the door to let the flock out.",
    body: `The first night I had the sword drawn and the place under his ribs chosen. Then I worked out what came after: the stone in the doorway ([[knowledge/cyclops-door-stone]]), and seven men who could not move it.

| Option | Result |
| --- | --- |
| Kill him asleep | We die in the cave, slowly |
| Wait and do nothing | We die in the cave, two at a time |
| Blind him, leave under the flock | He opens the door himself |

**Chosen:** blind him. We cut a length of his own olive-wood staff, sharpened it, hardened the point in the fire and hid it under the dung. I drew lots for four men to help me lift it. On the second evening, after the wine had put him down, we drove it in.

At dawn he moved the stone to let the rams out to pasture and sat in the doorway feeling their backs. Each man went out tied under the belly of the middle ram of three. I went last, holding on under the fleece of the leader.

**Cost:** none in men; the six were already lost.

**Consequence:** a living, blinded son of [[people/poseidon]], able to pray. See [[oaths/polyphemus-curse]].

## Questions retained

- [ ] Was there any version in which he was not left able to pray?

Related: [[voyage/day-98-the-stake]] and [[voyage/day-99-escape]]. Filed under [[decisions/_index]].`,
    links: ["oaths/polyphemus-curse.md", "decisions/_index.md", "knowledge/cyclops-door-stone.md", "people/poseidon.md", "voyage/day-98-the-stake.md", "voyage/day-99-escape.md"],
    fields: { day: 98, place: "Land of the Cyclopes", cost: "none in men" },
  },
  {
    path: "decisions/accept-the-bag-of-winds.md",
    title: "Accept the bag of winds",
    type: "decision",
    created: "2016-12-21",
    updated: "2016-12-31",
    status: "closed",
    tags: ["decision", "aeolia", "winds"],
    places: ["place:aeolia"],
    summary: "Aeolus tied every contrary wind into an oxhide bag and left only the west wind loose. I took it and did not tell the crew what was in it.",
    body: `A month as the guest of [[people/aeolus]] on his floating island, with its wall of bronze. He asked about Troy and I told it all. When I asked to be sent on, he gave the help a god's steward can give: every wind that could hinder us, tied into an oxhide bag with a cord of bright metal and stowed in the hold. He left the west wind ([[knowledge/zephyrus]]) free to carry us home.

| Option | Note |
| --- | --- |
| Decline it | Sail with whatever the season gives |
| Accept it and tell the crew | They would know not to touch it |
| Accept it and say nothing | Nobody asks about what they cannot see |

**Chosen:** accept, and say nothing. I did not want a ship's argument about a bag that must never be opened.

**Cost:** the voyage of [[decisions/keep-the-helm-nine-days]], and then a refusal.

**Consequence:** the crew saw a heavy bag, sealed and guarded by me, from a rich host. They drew the obvious conclusion. That conclusion was wrong, and I had given them no other.

## Questions retained

- [ ] Every decision to keep the crew uninformed has cost men or time. This one, the Sirens briefing ([[decisions/what-to-tell-the-crew]]) and Scylla. Is the habit the fault?
- [ ] Could the bag have been stowed where it did not look like plunder?

Related: [[crew/aeolia-bag]] and [[voyage/day-162-aeolia-departure]]. Filed under [[decisions/_index]].`,
    links: ["decisions/keep-the-helm-nine-days.md", "decisions/what-to-tell-the-crew.md", "decisions/_index.md", "people/aeolus.md", "knowledge/zephyrus.md", "crew/aeolia-bag.md", "voyage/day-162-aeolia-departure.md"],
    fields: { day: 162, place: "Aeolia", cost: "the voyage home, once", source: "Aeolus" },
  },
  {
    path: "decisions/keep-the-helm-nine-days.md",
    title: "Keep the helm nine days and sleep on the tenth",
    type: "decision",
    created: "2016-12-30",
    updated: "2016-12-30",
    status: "closed",
    tags: ["decision", "aeolia", "ithaca", "sleep"],
    people: ["person:penelope"],
    places: ["place:aeolia", "place:ithaca"],
    summary: "Held the sheet myself for nine days and nights. On the tenth Ithaca was in sight, with men tending fires on the shore, and I slept.",
    body: `I would not let anyone else handle the sheet. Nine days and nine nights at the helm, the west wind steady behind us. On the tenth the island was in sight, near enough to make out the herdsmen's fires along the shore.

Then I slept.

**Options at that hour:** hand the helm to Eurylochus and sleep; keep it until we beached; wake someone to stand over the bag.

**Chosen:** sleep, without a word about the bag. It was not really chosen. It was nine days of not sleeping, deciding for me.

While I slept the crew talked it over: Aeolus had given me treasure, I had kept it from them, and we were coming home from Troy empty-handed by comparison. They opened the bag. Every wind came out at once and took us straight back across the sea to Aeolia.

**Cost:** home, from within sight of it. I woke and thought of going over the side, and stayed, and lay down in the ship with my cloak over my head.

**Consequence:** [[decisions/return-to-aeolus]], on day 172.

## Questions retained

- [ ] Is there any watch I can stand for nine days that I should not share on the second?
- [ ] On the raft there is nobody to share it with. Seventeen days. Plan the sleep before the sea plans it: [[studies/sleep-on-a-single-hand-crossing]].

Related: [[voyage/day-171-ithaca-in-sight]] and [[crew/watch-rota]]. Filed under [[decisions/_index]]. Bearing on [[goals/return-to-ithaca]].`,
    links: ["decisions/return-to-aeolus.md", "goals/return-to-ithaca.md", "decisions/_index.md", "studies/sleep-on-a-single-hand-crossing.md", "voyage/day-171-ithaca-in-sight.md", "crew/watch-rota.md"],
    fields: { day: 171, place: "within sight of Ithaca", cost: "the homecoming" },
  },
  {
    path: "decisions/return-to-aeolus.md",
    title: "Go back and ask Aeolus again",
    type: "decision",
    created: "2016-12-31",
    updated: "2016-12-31",
    status: "closed",
    tags: ["decision", "aeolia", "gods"],
    places: ["place:aeolia"],
    summary: "Went to his hall a second time and asked for the winds again. He told us to leave his island, because a man sent back like that is hated by the gods.",
    body: `Blown back to the same island, we watered and ate on the beach, and I went up to the hall with a herald and one other man. [[people/aeolus]] was at table with his wife and children. I sat on the threshold and asked for help a second time.

| Option | Expected |
| --- | --- |
| Ask again | A second chance; he had been generous |
| Sail without asking | No wind to speak of, and the season going |

**Chosen:** ask. It was the reasonable request to make of a host who had already been generous once.

His answer, in substance: *leave my island at once. It is not right for me to help or send on a man the blessed gods hate, and you came back hated.*

**Cost:** his guest-friendship, logged as withdrawn at [[oaths/xenia-aeolus]]. Rowing after it, with no wind, the crew worn down by their own mistake.

**Consequence:** Aeolus's reading of the event is filed as a sign in its own right at [[omens/day-172-aeolus-reading]], because it was the first time anyone told me the gods might be against the voyage and not just indifferent.

## Questions retained

- [ ] Was it worth the asking? It cost nothing he had not already decided.

Related: [[voyage/day-172-aeolus-refuses]] and [[journal/day-172]]. Filed under [[decisions/_index]].`,
    links: ["oaths/xenia-aeolus.md", "omens/day-172-aeolus-reading.md", "decisions/_index.md", "people/aeolus.md", "voyage/day-172-aeolus-refuses.md", "journal/day-172.md"],
    fields: { day: 172, place: "Aeolia", cost: "his guest-friendship" },
  },
  {
    path: "decisions/moor-outside-the-harbour.md",
    title: "Moor ship 1 outside the harbour",
    type: "decision",
    created: "2017-02-02",
    updated: "2017-02-02",
    status: "closed",
    tags: ["decision", "laestrygonians", "losses"],
    places: ["place:laestrygonians"],
    summary: "Eleven ships went into the still water inside the cliffs. I tied up outside, to a rock at the entrance. That is the whole reason anyone lived past day 205.",
    body: `The harbour of the Laestrygonians is ringed by cliffs on both sides with a narrow mouth between two headlands. Inside, the water was flat calm. The other eleven captains took their ships in and moored them close together.

I kept ship 1 outside, made fast to a rock at the very end of the point.

| Option | My reasoning at the time |
| --- | --- |
| In with the fleet | Shelter; company |
| Outside, alone | A harbour with one door is a pen |

**Chosen:** outside. I had no information. It was a habit from Troy: keep a way out.

Three scouts went inland. One was taken and eaten in the king's hall ([[people/antiphates]]); he came from the eleven ships and is counted in their 484. The Laestrygonians gathered on the cliffs in thousands and stoned the ships in the harbour, then speared the men like fish and carried them off.

**Cost:** for ship 1, none. For the fleet, 11 ships and 484 men, 44 from each ([[crew/losses/laestrygonians]]).

**Consequence:** 38 men in one ship, from twelve ships and six hundred. See [[decisions/cut-the-cable]] for how we got away, [[voyage/day-205-laestrygonian-harbour]] for the day, and [[crew/_index]] for the ledger.

## Questions retained

- [ ] I did not tell the other captains why. I did not have a why. Would they have listened to a habit?
- [ ] There is no ship 1 now. Is the raft moored where it has a way out? It is on an open beach. Check.

Filed under [[decisions/_index]].`,
    links: ["decisions/cut-the-cable.md", "crew/_index.md", "decisions/_index.md", "people/antiphates.md", "crew/losses/laestrygonians.md", "voyage/day-205-laestrygonian-harbour.md"],
    fields: { day: 205, place: "Land of the Laestrygonians", cost: "11 ships, 484 men (fleet)" },
  },
  {
    path: "decisions/cut-the-cable.md",
    title: "Cut the cable and row",
    type: "decision",
    created: "2017-02-02",
    updated: "2017-02-02",
    status: "closed",
    tags: ["decision", "laestrygonians", "crew"],
    places: ["place:laestrygonians"],
    summary: "Drew my sword and cut the mooring line rather than wait to cast off properly, and told the crew to row for their lives. They did.",
    body: `While the harbour was being destroyed behind the headland, there was a short time in which ship 1 could still leave.

**Options:**

1. Go in and fight for the other eleven.
2. Cast off in good order and stand off to see what could be saved.
3. Cut the line and go.

There was nothing to save. The ships inside were already broken and the men were being taken off the water. Going in would have been the twelfth ship lost.

**Chosen:** I drew my sword, cut the cable at the rock, and shouted to the crew to bend to the oars. They rowed as hard as frightened men can, and we cleared the cliffs before the stones reached us.

**Cost:** one mooring cable. The eleven ships behind us, which I counted under [[decisions/moor-outside-the-harbour]] and do not count twice.

**Consequence:** we sailed on grieving for our friends and glad to be alive, and the next land was Aeaea ([[voyage/day-246-aeaea-arrival]]).

## Questions retained

- [ ] I did not go back. I have gone over it many times and it comes out the same each time. Keep the question open anyway; it should not close easily.

See [[journal/day-206]], [[crew/roll-calls/day-206]] and [[crew/_index]]. Filed under [[decisions/_index]].`,
    links: ["decisions/moor-outside-the-harbour.md", "crew/_index.md", "decisions/_index.md", "voyage/day-246-aeaea-arrival.md", "journal/day-206.md", "crew/roll-calls/day-206.md"],
    fields: { day: 205, place: "Land of the Laestrygonians", cost: "one cable" },
  },
  {
    path: "decisions/split-the-crew-on-aeaea.md",
    title: "Split the crew on Aeaea",
    type: "decision",
    created: "2017-03-16",
    updated: "2017-03-16",
    status: "closed",
    tags: ["decision", "aeaea", "crew"],
    people: ["person:eurylochus", "person:circe"],
    places: ["place:aeaea"],
    summary: "Two companies, lots drawn in a helmet: Eurylochus and twenty-two, or me and fifteen. His lot came out, his company went to the house in the woods, and only he came back.",
    body: `After the Laestrygonians no one wanted to walk into another stranger's house. We had seen smoke rising through the oak woods from the middle of the island and needed to know whose it was.

| Option | Problem |
| --- | --- |
| Everyone goes | One mistake loses the ship |
| Nobody goes | No water, no knowledge of the island |
| Two companies, one stays with the ship | Half the risk; someone left to act |

**Chosen:** two companies, twenty-three under [[crew/eurylochus]] counting him and fifteen with me, thirty-eight in all, and lots shaken in a bronze helmet for which company went. His lot leapt out.

His men went in to [[people/circe]] and came out as swine, with their minds intact ([[knowledge/circe-drugs]]). Eurylochus suspected a trap and stayed outside the door, and ran back to the ship alone, so frightened he could hardly speak.

**Cost:** none permanent. The twenty-two were restored. That is the next decision: [[decisions/go-to-circe-alone]].

**Consequence:** the lot was fair, and Eurylochus has never trusted my judgement since, on the grounds that it was mine.

## Questions retained

- [ ] Lots keep the leader's preference out of it. Did it also keep the leader's judgement out of it?

Related: [[crew/aeaea-scouting-party]] and [[voyage/day-247-the-swine]]. Filed under [[decisions/_index]].`,
    links: ["crew/eurylochus.md", "people/circe.md", "decisions/go-to-circe-alone.md", "decisions/_index.md", "knowledge/circe-drugs.md", "crew/aeaea-scouting-party.md", "voyage/day-247-the-swine.md"],
    fields: { day: 247, place: "Aeaea", cost: "none permanent" },
  },
  {
    path: "decisions/go-to-circe-alone.md",
    title: "Go to Circe alone, with moly",
    type: "decision",
    created: "2017-03-17",
    updated: "2017-03-17",
    status: "closed",
    tags: ["decision", "aeaea", "gods"],
    people: ["person:circe", "person:eurylochus"],
    places: ["place:aeaea"],
    summary: "Eurylochus begged me not to go and to sail at once. I went alone. Hermes met me on the path with a root to take against her drug.",
    body: `Eurylochus asked to be left at the ship and urged the rest of us to sail away while we could. Twenty-two men were in pens up the hill.

| Option | Who argued for it |
| --- | --- |
| Sail now, leave the twenty-two | Eurylochus |
| Go in force | Nobody; we had seen what happened to force |
| Go alone | Me |

**Chosen:** alone. A strong necessity was on me, and I could not ask another man to walk in where twenty-two had just walked in.

On the path through the woods a young man met me, and it was [[people/hermes]]. He gave me a plant with a root that is hard to dig and a small flower, which the gods call moly and men cannot easily dig up ([[knowledge/moly]]). It would hold off her drug. He told me what to do: when she struck me with her wand, draw my sword as if to kill her; when she offered her bed, first make her swear the great oath of the gods. That oath is at [[oaths/circe-no-harm]].

It went as he said. She mixed the cup, it did nothing, I drew the sword, she fell at my knees and knew who I was.

**Cost:** none.

**Consequence:** the twenty-two restored, younger and taller than before; a year on the island ([[decisions/stay-the-year]]).

## Questions retained

- [ ] Would I have gone without meeting Hermes? Yes. Would I have come out?

See [[people/circe]] and [[voyage/day-248-moly]]. Filed under [[decisions/_index]].`,
    links: ["oaths/circe-no-harm.md", "decisions/stay-the-year.md", "people/circe.md", "decisions/_index.md", "people/hermes.md", "knowledge/moly.md", "voyage/day-248-moly.md"],
    fields: { day: 248, place: "Aeaea", cost: "none", source: "Hermes" },
  },
  {
    path: "decisions/stay-the-year.md",
    title: "Stay the year on Aeaea",
    type: "decision",
    created: "2017-03-18",
    updated: "2018-03-14",
    status: "closed",
    tags: ["decision", "aeaea", "delay"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "Meant to rest the crew. Stayed until the seasons came round again, and it was the crew who had to remind me of home.",
    body: `There was no single day on which I decided to stay a year. There was a first day on which staying was sensible, and a great many days after it on which nobody decided anything.

**Day 249.** Circe told us to rest until we had our strength back. Reasonable: 38 men, one ship, twenty-two of them just out of a pen.

**Months later.** Feasting, meat without end and sweet wine ([[journal/day-430]]). Nothing in the brain for weeks except the weather.

**Day 608.** The crew took me aside ([[voyage/day-608-the-crew-ask]]). *It is time to remember your own country, if you are fated to be saved and reach your high-roofed house.* I agreed at once, which says it had been sitting there unasked.

| Measure | Value |
| --- | --- |
| Days on Aeaea, first stay | 365 (days 246 to 611) |
| Men lost | 0 until the last morning |
| Decisions recorded | Very few |

**Cost:** 365 days. The year itself was not unhappy, which is the difficulty in costing it.

**Consequence:** when I asked Circe to send me home she said the road went first to the house of the dead: [[decisions/go-to-the-dead]].

## Questions retained

- [ ] What review would have caught this at day 300? Write it down now, because Ogygia was the same failure at seven times the length.
- [ ] The crew asked first. Twice the crew has had to raise home with me. Note it.

See [[people/circe]] and [[voyage/legs/aeaea-first-stay]]. Filed under [[decisions/_index]].`,
    links: ["decisions/go-to-the-dead.md", "people/circe.md", "decisions/_index.md", "journal/day-430.md", "voyage/day-608-the-crew-ask.md", "voyage/legs/aeaea-first-stay.md"],
    fields: { day: 608, place: "Aeaea", cost: "365 days" },
  },
  {
    path: "decisions/go-to-the-dead.md",
    title: "Go to the house of the dead",
    type: "decision",
    created: "2018-03-12",
    updated: "2018-03-24",
    status: "closed",
    tags: ["decision", "acheron", "teiresias"],
    people: ["person:circe", "person:teiresias"],
    places: ["place:aeaea", "place:acheron"],
    summary: "Asked to be sent home. Circe said I would have to consult Teiresias first, among the dead, and gave the directions. I sat on the bed and wept, and then went.",
    body: `> You must first make another journey, to the house of Hades and dread Persephone, to consult the spirit of Teiresias of Thebes, the blind seer, whose mind is still whole. — Circe, day 608

No one has ever sailed there in a ship. I sat on her bed and wept and did not want to live. Then I asked who would guide us.

**Options:** refuse and sail for Ithaca by guesswork; go, as told.

**Chosen:** go. Circe was the only source on the route with a perfect record so far, and the route ahead was unknown water.

She gave the method in full ([[knowledge/rites-for-the-dead]]): sail to the grove of Persephone at the edge of Ocean, beach where the rivers meet at the rock, dig a pit a forearm square, pour the three drinks for the dead, promise the offerings at home ([[oaths/vow-to-the-dead]]), sacrifice a ram and a ewe, and hold the other spirits back with the sword until Teiresias has drunk.

**Cost:** about nine days' sailing and the crew's nerve. They wept when told.

**Consequence:** [[knowledge/teiresias-forecast]]; my mother ([[people/anticleia]]), dead of grief; Agamemnon; Achilles; Ajax, who would not speak. And Elpenor, who was owed something: [[decisions/bury-elpenor-first]].

## Questions retained

- [ ] I know more of what is coming than any man alive. Has it made a single decision since easier?

See [[people/teiresias]] and [[voyage/day-620-acheron]]. Filed under [[decisions/_index]].`,
    links: ["oaths/vow-to-the-dead.md", "knowledge/teiresias-forecast.md", "decisions/bury-elpenor-first.md", "people/teiresias.md", "decisions/_index.md", "knowledge/rites-for-the-dead.md", "people/anticleia.md", "voyage/day-620-acheron.md"],
    fields: { day: 608, place: "the house of the dead", cost: "nine days' sailing", source: "Circe" },
  },
  {
    path: "decisions/bury-elpenor-first.md",
    title: "Bury Elpenor before anything else",
    type: "decision",
    created: "2018-03-27",
    updated: "2018-03-28",
    status: "closed",
    tags: ["decision", "aeaea", "crew", "burial"],
    people: ["person:elpenor", "person:circe"],
    places: ["place:aeaea"],
    summary: "Back on Aeaea with the forecast and every reason to hurry, the first thing done was to fetch Elpenor's body down from Circe's house and burn it, as he asked.",
    body: `Elpenor was the first of the dead to come to the pit, before Teiresias. He had fallen from Circe's roof the morning we left, asleep where he had lain down to get cool, and broken his neck ([[crew/losses/aeaea]]). Nobody had noticed he was missing. He asked to be burned with his armour, a barrow raised on the shore, and his oar planted on top of it, the one he rowed with among his friends. I promised: [[oaths/promise-to-elpenor]].

On the return to Aeaea there were two claims on the first day:

| Option | Argument |
| --- | --- |
| Ask Circe for the route first | We had the forecast and a season to use |
| Bury Elpenor first | He asked; the dead do not ask twice |

**Chosen:** Elpenor. We cut wood on the headland at first light, burned him with his armour, raised the barrow and set up a stone, and fixed his oar on top ([[crew/barrow-on-aeaea]]).

**Cost:** one day.

**Consequence:** the promise is the only oath in this brain that was made to a dead man and is fully kept. The record of the man is at [[crew/elpenor]]; the day, at [[voyage/day-624-elpenor-buried]].

## Questions retained

- [ ] None. Kept so this list has one entry with nothing left to review.

Filed under [[decisions/_index]].`,
    links: ["oaths/promise-to-elpenor.md", "crew/elpenor.md", "decisions/_index.md", "crew/losses/aeaea.md", "crew/barrow-on-aeaea.md", "voyage/day-624-elpenor-buried.md"],
    fields: { day: 624, place: "Aeaea", cost: "one day" },
  },
  {
    path: "decisions/wait-out-the-seasons.md",
    title: "Wait out the seasons on Aeaea",
    type: "decision",
    created: "2018-03-28",
    updated: "2019-05-16",
    status: "closed",
    tags: ["decision", "aeaea", "delay", "weather"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "The second stay. This time a decision, written down, with a reason and an end date: no sailing until the route and the season were both known.",
    body: `After the first year on Aeaea went by without anyone choosing it ([[decisions/stay-the-year]]), I wanted the second stay to be a decision with a reason and a review.

**Reason:** the forecast gave the destination and the condition, not the route. The open sea in the wrong season had already cost us Malea and the bag of winds.

| Option | Risk |
| --- | --- |
| Sail at once with the forecast only | Unknown water, late in the year |
| Stay until Circe gives the route and the season turns | Time |

**Chosen:** stay, with a review every month. The review was kept.

**Cost:** days 623 to 1039, waiting out the seasons. Over a year more on top of the first.

**Consequence:** on day 1038 ([[voyage/day-1038-circes-route]]) Circe gave the route in order and in full: the Sirens, then the choice of the Wandering Rocks ([[knowledge/wandering-rocks]]) or the strait between Scylla and Charybdis, then Thrinacia and the herds. Every item turned out to be correct. See [[knowledge/sirens]], [[knowledge/scylla]], [[knowledge/charybdis]], [[knowledge/thrinacia-cattle]].

## Questions retained

- [ ] Would the route have been given sooner if I had asked sooner?
- [ ] Is the difference between this stay and the first one only that this one was written down? If so, that is worth knowing.

Filed under [[decisions/_index]].`,
    links: ["decisions/stay-the-year.md", "knowledge/sirens.md", "knowledge/scylla.md", "knowledge/charybdis.md", "decisions/_index.md", "voyage/day-1038-circes-route.md", "knowledge/wandering-rocks.md", "knowledge/thrinacia-cattle.md"],
    fields: { day: 1038, place: "Aeaea", cost: "days 623 to 1039" },
  },
  {
    path: "decisions/what-to-tell-the-crew.md",
    title: "Tell the crew about the Sirens, not about Scylla",
    type: "decision",
    created: "2019-05-19",
    updated: "2019-05-21",
    status: "settled",
    tags: ["decision", "crew", "sirens", "scylla"],
    people: ["person:circe"],
    places: ["place:sirens", "place:scylla"],
    summary: "The briefing given at sea before the Sirens. Everything about the singing and the wax, and nothing about what was waiting two days on.",
    body: `Circe gave me the route on day 1038 privately. On the morning of day 1041, with the Sirens' island ahead, I had to decide what the crew needed to hear.

| Hazard | Told? | Reasoning |
| --- | --- | --- |
| Sirens | Yes, in full | The defence needs every man's hands: wax in every ear, rope on me |
| Wandering Rocks | That we would not take them | Nothing for them to do |
| Charybdis | Yes | Holding away from it needs the helmsman and the rowers |
| Scylla | **No** | Nothing they could do but row, and they row worse afraid |

The Sirens briefing worked; see [[voyage/day-1040-eve-of-the-sirens]], [[crew/sirens-wax]], [[knowledge/sirens]] and [[voyage/day-1041-sirens]].

The Scylla omission is argued at length in [[decisions/scylla-or-charybdis]]. This record only notes that it was made at the same moment, in the same speech, by the same reasoning that got the Sirens right. That is why it needs its own entry: the method was sound for one hazard and not obviously sound for the other, and I did not separate them.

**Cost:** see the Scylla record. Six men ([[crew/scylla-six]]), who did not know.

## Questions retained

- [ ] Is "they can do nothing about it" ever a reason to keep it from them?
- [ ] Would the men have rowed harder or worse? I am the only one left who could answer, and I cannot.

Filed under [[decisions/_index]].`,
    links: ["knowledge/sirens.md", "voyage/day-1041-sirens.md", "decisions/scylla-or-charybdis.md", "decisions/_index.md", "voyage/day-1040-eve-of-the-sirens.md", "crew/sirens-wax.md", "crew/scylla-six.md"],
    fields: { day: 1041, place: "at sea, before the Sirens", cost: "see the Scylla record" },
  },
  {
    path: "decisions/hear-the-sirens.md",
    title: "Hear the Sirens, bound",
    type: "decision",
    created: "2019-05-19",
    updated: "2019-05-19",
    status: "closed",
    tags: ["decision", "sirens", "risk"],
    places: ["place:sirens"],
    summary: "Circe said I could hear them if I wished, tied hand and foot to the mast. I wished. Nobody else was given the choice.",
    body: `Wax would have done for me as well as for the crew. Circe offered a second way: if I wanted to hear the song, have myself bound upright to the mast-step, hand and foot, and order the men to tie me tighter if I begged to be let go.

**Options:** wax like everyone else; bound and listening.

**Chosen:** bound and listening. I wanted to know what it was that had piled the meadow with bones. That is the whole of the reason and it is not a good one.

The terms I gave the crew are at [[oaths/sirens-binding-order]]: if I begged or ordered, more rope, not less.

It went as described. Their song promised knowledge of everything that happens on the earth and of everything at Troy. I signalled with my brows to be untied. [[crew/perimedes]] and [[crew/eurylochus]] stood up and bound me tighter, and the crew rowed on until the voice was gone.

**Cost:** none in men. One morning of not being trusted with my own decisions, which was the plan.

**Consequence:** I know what the Sirens sound like. It has not been useful since.

## Questions retained

- [ ] Would I do it again? Yes. Note that the answer is yes and that it ought not to be.

See [[knowledge/sirens]] and [[crew/sirens-wax]]. Filed under [[decisions/_index]].`,
    links: ["oaths/sirens-binding-order.md", "knowledge/sirens.md", "decisions/_index.md", "crew/perimedes.md", "crew/eurylochus.md", "crew/sirens-wax.md"],
    fields: { day: 1041, place: "the Sirens", cost: "none", source: "Circe" },
  },
  {
    path: "decisions/arm-against-scylla.md",
    title: "Arm against Scylla",
    type: "decision",
    created: "2019-05-21",
    updated: "2019-05-21",
    status: "closed",
    tags: ["decision", "scylla", "advice"],
    people: ["person:circe"],
    places: ["place:scylla", "place:messina"],
    summary: "Circe told me not to arm: she is not a mortal thing and there is no fighting her. I put on my armour and took two spears to the foredeck anyway.",
    body: `Circe was explicit: Scylla is not a mortal evil but an immortal one, and there is no defence; the only course is to row past as fast as possible and call on her mother to stop her striking twice.

I forgot that advice, or chose to. I put on my armour, took two long spears, and stood on the foredeck where I expected her to show first.

| Option | Expected effect |
| --- | --- |
| Do as advised, row | Six men lost |
| Arm and watch | Perhaps fewer |

**Chosen:** arm. I could not stand on the deck and do nothing.

I never saw her. I wore out my eyes looking at the cliff. She took six from amidships ([[crew/losses/scylla]]) while we were all watching Charybdis on the other side. The armour did nothing, and as far as I can tell, it cost nothing either: nobody stopped rowing because of it.

**Cost:** none attributable. The six are counted under [[decisions/scylla-or-charybdis]].

**Consequence:** a lesson recorded in [[knowledge/scylla]] in plainer words than mine: not a fight.

## Questions retained

- [ ] Who was the armour for? Not for them.

See also [[voyage/day-1043-strait]] and [[studies/strait-passages-compared]]. Filed under [[decisions/_index]].`,
    links: ["decisions/scylla-or-charybdis.md", "knowledge/scylla.md", "voyage/day-1043-strait.md", "decisions/_index.md", "crew/losses/scylla.md", "studies/strait-passages-compared.md"],
    fields: { day: 1043, place: "the strait", cost: "none attributable", source: "Circe" },
  },
  {
    path: "decisions/land-on-thrinacia.md",
    title: "Land on Thrinacia",
    type: "decision",
    created: "2019-05-22",
    updated: "2019-05-22",
    status: "closed",
    tags: ["decision", "thrinacia", "crew"],
    people: ["person:eurylochus", "person:teiresias", "person:circe"],
    places: ["place:thrinacia"],
    summary: "Both Teiresias and Circe said to pass the island by. Eurylochus spoke for an exhausted crew and the crew backed him. I gave way, on an oath.",
    body: `Day 1044. We had come out of the strait the day before with six men fewer, and towards evening we heard the cattle lowing and the sheep bleating across the water from the island of the Sun.

Two sources, both correct on every point so far, had said the same thing: *avoid the island of Helios, who gives joy to men, for there the worst disaster waits for you.* I told the crew so.

Eurylochus answered for them ([[crew/dissent-log]]):

> You are hard, Odysseus. Your strength does not give out, and you never tire. Are you made of iron, that you will not let your men land, worn out and sleepy, and cook a meal? Night is when the winds come up that wreck ships.

The crew shouted agreement.

| Option | Cost |
| --- | --- |
| Row on through the night | A mutiny, or a crew too tired to row |
| Land, under conditions | Every man to swear not to touch the herds |

**Chosen:** land, under an oath. Sworn that night, day 1044, before we moored: [[oaths/helios]]; who swore is at [[crew/oath-signatories]].

**Cost:** see [[decisions/cattle-of-helios]]. The landing was not the loss; it made the loss possible.

**Consequence:** the wind turned against us the next day and stayed there for a month.

## Questions retained

- [ ] He was outnumbering me, not out-arguing me. Is that a reason to give way? It was the right call on the strength of the men and the wrong one on the strength of the sources.
- [ ] I knew more than they did and could not make it count. Why not?

See [[crew/eurylochus]] and [[voyage/day-1044-thrinacia-landfall]]. Filed under [[decisions/_index]].`,
    links: ["oaths/helios.md", "decisions/cattle-of-helios.md", "crew/eurylochus.md", "decisions/_index.md", "crew/dissent-log.md", "crew/oath-signatories.md", "voyage/day-1044-thrinacia-landfall.md"],
    fields: { day: 1044, place: "Thrinacia", cost: "the ship, eventually", source: "Teiresias and Circe" },
  },
  {
    path: "decisions/hold-the-fig-tree.md",
    title: "Hold the fig tree",
    type: "decision",
    created: "2019-07-02",
    updated: "2019-07-02",
    status: "closed",
    tags: ["decision", "charybdis", "survival"],
    places: ["place:charybdis", "place:messina"],
    summary: "Swept back to Charybdis on the wreckage, I jumped for the fig tree on the rock and hung there until she gave the keel and mast back up.",
    body: `After the storm on day 1084 ([[voyage/day-1084-the-storm]]) I lashed the mast to the keel with the backstay and rode them. The south wind ([[knowledge/notus]]) came up in the night and carried me back to the strait. By dawn I was at Charybdis as she began to swallow.

**Options:**

1. Stay on the timbers and go down with them.
2. Swim for it. Nobody swims away from that.
3. The fig tree above the whirlpool.

**Chosen:** the fig tree. I leapt up and caught hold of it and clung there like a bat. There was nowhere to set my feet and no way to climb: the roots were far below and the branches far above, long and wide, overshadowing the water.

I held on until she spewed the mast and keel back up, late, at the hour a man leaves the assembly for his supper after judging disputes. Then I let go, dropped into the water beside them, sat astride, and paddled with my hands.

**Cost:** nothing further. There was nothing further left to lose but me.

**Consequence:** nine days adrift. On the tenth night the gods brought me to Ogygia, day 1095 ([[ogygia/island/day-1095-landfall]]). See [[knowledge/charybdis]]; the line about the fig tree there is mine.

## Questions retained

- [ ] None about the tree. About the timing: why did I wait for the timbers rather than swim to the far shore while she was still?

Filed under [[decisions/_index]]. The day itself: [[voyage/day-1085-the-fig-tree]]. Ledger at [[crew/_index]].`,
    links: ["knowledge/charybdis.md", "crew/_index.md", "decisions/_index.md", "voyage/day-1084-the-storm.md", "knowledge/notus.md", "ogygia/island/day-1095-landfall.md", "voyage/day-1085-the-fig-tree.md"],
    fields: { day: 1085, place: "Charybdis", cost: "none further" },
  },
  {
    path: "decisions/refuse-immortality.md",
    title: "Refuse immortality",
    type: "decision",
    created: "2020-11-03",
    updated: "2026-07-07",
    status: "settled",
    tags: ["decision", "ogygia", "calypso"],
    people: ["person:calypso", "person:penelope"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "Calypso offered to make me deathless and ageless if I stayed. Offered at the hearth on day 1575 and refused the same night; never pressed again.",
    body: `The offer was made at the hearth ([[ogygia/island/hearth]]) on day 1575, in our second year on the island: stay with her in the cave, and she would make me immortal and ageless for all my days. I refused it the same night. She did not make it again; on the night of day 3647 she asked only whether I was sure.

| Option | What it gives | What it costs |
| --- | --- | --- |
| Stay | No death, no age, a goddess's house | Ithaca, Penelope, my son, my name among men |
| Leave | A raft, a sea, an old age, a death | Everything she offered |

**Chosen:** leave, as soon as there was a way.

My answer to her on day 1575, as near as I can set it down, and the same answer when she asked again on day 3647:

> Goddess, do not be angry with me. I know that wise [[people/penelope]] is nothing to look at beside you, in height or beauty, for she is mortal and you are deathless and ageless. Even so, I want and long every day to go home and see the day of my return.

**Cost:** immortality. Written plainly so it is never written smaller than it is.

**Consequence:** none until day 3647, when Hermes made the question moot. See [[decisions/accept-calypso-release]].

## Questions retained

- [ ] For seven years refusing was the only decision I made on this island. Was refusing enough, or should I have been building something sooner?

See [[people/calypso]], [[ogygia/the-offer]], [[journal/day-1575]] and [[ogygia/_index]]. Filed under [[decisions/_index]].`,
    links: ["people/penelope.md", "decisions/accept-calypso-release.md", "people/calypso.md", "ogygia/_index.md", "decisions/_index.md", "ogygia/island/hearth.md", "ogygia/the-offer.md", "journal/day-1575.md"],
    fields: { day: 1575, place: "Ogygia", cost: "immortality" },
  },
  {
    path: "decisions/accept-calypso-release.md",
    title: "Accept Calypso's release, on oath",
    type: "decision",
    created: "2026-07-07",
    updated: "2026-07-07",
    status: "settled",
    tags: ["decision", "ogygia", "calypso", "oath"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "She came to the shore and said I could go. After seven years I did not believe her, and would not touch the raft until she had sworn the great oath.",
    body: `Calypso found me on the headland ([[ogygia/island/headland]]) where I had sat every day for years, and told me to stop grieving: she would send me off with goodwill. Cut timbers, build a broad raft, deck it high; she would give bread, water and wine, and clothes, and send a fair wind.

I did not know then that Hermes had come that morning with the order from Zeus ([[ogygia/build/day-3647-the-order]]). All I had was a goddess who had kept me seven years, now offering a raft on open sea.

| Option | Risk |
| --- | --- |
| Accept at once | A raft is an easy way to drown a man without being blamed for it |
| Refuse | Seven more years |
| Accept, on an oath | She might refuse to swear |

**Chosen:** accept on an oath. I would not set foot on a raft unless she swore the great oath that she was planning no further harm.

She smiled, stroked my hand, called me a rogue, and swore by Earth, by the wide heaven above, and by the falling water of the Styx, which is the greatest oath the gods have. Recorded at [[oaths/calypso-no-harm]].

**Cost:** none. It was the first thing in seven years that cost nothing.

**Consequence:** [[decisions/build-rather-than-wait]], started the next morning.

## Questions retained

- [ ] She told me afterwards about Hermes. Would I have trusted the release more, or less, if she had said so first?

See [[people/calypso]] and [[journal/day-3647]]. Filed under [[decisions/_index]].`,
    links: ["oaths/calypso-no-harm.md", "decisions/build-rather-than-wait.md", "people/calypso.md", "decisions/_index.md", "ogygia/island/headland.md", "ogygia/build/day-3647-the-order.md", "journal/day-3647.md"],
    fields: { day: 3647, place: "Ogygia", cost: "none", source: "Calypso" },
  },
  {
    path: "decisions/build-rather-than-wait.md",
    title: "Build a raft rather than wait for a ship",
    type: "decision",
    created: "2026-07-07",
    updated: "2026-07-11",
    status: "settled",
    tags: ["decision", "ogygia", "raft"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "No ship has called at Ogygia in seven years and none will. Built a raft in four days with her tools and twenty of her trees.",
    body: `Ogygia is far out, and no ships with crews come there. In seven years I counted none that called, and stopped counting in the fifth (see [[journal/day-2914]] and [[ogygia/island/sightings]]).

| Option | Time | Dependence |
| --- | --- | --- |
| Wait for a ship | Unbounded | Chance |
| Ask Calypso to send me on some other way | Unknown | Her |
| Build | Days | My hands, her tools |

**Chosen:** build. The release ([[decisions/accept-calypso-release]]) was conditional on nothing but my own work, which made it the first plan in years whose outcome depended on me.

Calypso brought a great bronze axe, double-edged, with an olive-wood handle, and a polished adze ([[ogygia/workshop/tools]]), and led me to the end of the island where the tall trees grow: alder, poplar, and fir as high as the sky, long dry and seasoned, that would float well. I felled twenty, seven fir, seven alder and six poplar, and trimmed them ([[ogygia/build/timber-log]]). She brought augers; I bored and fitted them, pegged and jointed. Then decking, a mast and yard, a steering oar, wickerwork bulwarks against the sea, and ballast. She brought cloth for the sail and I made it.

Four days, days 3648 to 3651. The build is recorded at [[voyage/ogygia/raft]], [[ogygia/build/plan]] and [[voyage/ogygia/_index]].

**Cost:** four days' labour, twenty of her trees.

**Consequence:** a vessel. Whether it holds is the next record: [[decisions/leave-today]].

## Questions retained

- [ ] The trees were there for seven years. The tools were in the cave. What did I need, other than leave?

Filed under [[decisions/_index]].`,
    links: ["journal/day-2914.md", "decisions/accept-calypso-release.md", "voyage/ogygia/raft.md", "voyage/ogygia/_index.md", "decisions/leave-today.md", "decisions/_index.md", "ogygia/island/sightings.md", "ogygia/workshop/tools.md", "ogygia/build/timber-log.md", "ogygia/build/plan.md"],
    fields: { day: 3648, place: "Ogygia", cost: "four days, twenty trees" },
  },
  {
    path: "decisions/leave-today.md",
    title: "Leave today rather than after the season",
    type: "decision",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "active",
    tags: ["decision", "ogygia", "raft", "departure"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:scheria"],
    summary: "The raft is finished, the wind is offered, and the safe answer is to wait until the sea is calmer. Launching this morning, 12 July. Open until the shore is out of sight.",
    body: `**Status: active.** Planned launch this morning. Seventeen days of open water to a planned landfall at Scheria on 29 July. Nothing below has happened yet.

| Option | For | Against |
| --- | --- | --- |
| Leave today | The release, the oath and the wind are all in hand now | One raft, no crew, one water-skin |
| Wait for a calmer month | Safer sea | A goddess's goodwill is not a standing order; the release came from Zeus, not from her |
| Wait a few days for more water | Two more jars, about 10 litres each, proposed | Every day here is a day the release could be taken back |

**Chosen (provisionally):** today. Every delay on this voyage has been a delay that seemed sensible on its first day ([[decisions/stay-the-year]]).

**Cost (expected):** the open-water risk of a single-handed raft over about 632 km to Scheria ([[studies/crossing-distance-and-margin]]), and sleep. [[decisions/keep-the-helm-nine-days]] is the precedent and it is not a good one.

**Known shortfall:** water ([[ogygia/stores/water]], [[studies/water-ration]]). One larger skin from Calypso, about 18 litres, aboard for seventeen days. Two more jars, about 10 litres each, proposed and not yet aboard. Flagged for review before the raft goes in the water, not after.

**Consequence:** to be recorded.

## Questions retained

- [ ] Is one skin of water enough? Review the shortfall; ask her for the two jars before launch.
- [ ] Who knows I have left? Nobody who can act on it.
- [ ] Sleep plan for seventeen days alone. Write it, from [[studies/sleep-on-a-single-hand-crossing]].
- [ ] Keep the Bear on the left hand: [[decisions/sail-by-the-bear]].

See [[journal/day-3652]] and [[voyage/ogygia/raft]]. Filed under [[decisions/_index]].`,
    links: ["decisions/stay-the-year.md", "decisions/keep-the-helm-nine-days.md", "decisions/sail-by-the-bear.md", "journal/day-3652.md", "voyage/ogygia/raft.md", "decisions/_index.md", "studies/crossing-distance-and-margin.md", "ogygia/stores/water.md", "studies/water-ration.md", "studies/sleep-on-a-single-hand-crossing.md"],
    fields: { day: 3652, place: "Ogygia", cost: "open-water risk", confidence: "planned" },
  },
  {
    path: "decisions/sail-by-the-bear.md",
    title: "Steer by the Bear, east of north",
    type: "decision",
    created: "2026-07-11",
    updated: "2026-07-12",
    status: "active",
    tags: ["decision", "navigation", "stars"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:scheria"],
    summary: "Calypso's directions: keep the Great Bear on the left hand all the way. No other method is available on a raft, so this is the method.",
    body: `**Status: active.** Adopted for the crossing that begins today. Not yet tested.

Calypso's directions ([[ogygia/build/sailing-directions]]), given at the fire on day 3651, the last night before the launch:

> Keep the Bear, which men also call the Wain, on your left hand as you sail. It turns in one place and watches Orion, and alone of the stars it never bathes in the stream of Ocean.

Also to watch: the Pleiades ([[knowledge/pleiades]]), and Boötes, who sets late.

| Method | Available on the raft? |
| --- | --- |
| Coastal pilotage | No coast for most of the way |
| A pilot | No |
| Soundings | No line long enough |
| The stars, by night | Yes |
| The sun and the wind, by day | Yes, roughly |

**Chosen:** the Bear ([[knowledge/great-bear]]) on the left hand, heading east of north; the numbers are at [[studies/steering-by-the-bear]]. By day, hold the wind on the same quarter and correct at nightfall.

**Cost (expected):** nothing by night, if the sky is clear. On a cloudy night, nothing to steer by. That is a real gap and it is written down so it is not forgotten.

**Consequence:** a planned landfall on Scheria, 29 July. Planned, not seen.

## Questions retained

- [ ] What to do on an overcast night: hold the last heading, or heave to?
- [ ] The observation that started this is at [[omens/day-3650-the-bear]].

See [[decisions/leave-today]]. Filed under [[decisions/_index]].`,
    links: ["omens/day-3650-the-bear.md", "decisions/leave-today.md", "decisions/_index.md", "ogygia/build/sailing-directions.md", "knowledge/pleiades.md", "knowledge/great-bear.md", "studies/steering-by-the-bear.md"],
    fields: { day: 3651, place: "Ogygia", cost: "none expected", source: "Calypso" },
  },

  // -------------------------------------------------------------------- oaths
  {
    path: "oaths/calypso-no-harm.md",
    title: "Calypso's oath not to plot harm",
    type: "oath",
    created: "2026-07-07",
    updated: "2026-07-12",
    status: "outstanding",
    tags: ["oath", "calypso", "ogygia"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Sworn by Earth, the wide heaven and the falling water of the Styx: that she is planning no further harm against me. Held so far. Holds until the raft is out of sight.",
    body: `| | |
| --- | --- |
| Sworn by | Calypso |
| Sworn to | Me |
| By what | Earth, the wide heaven above, the falling water of the Styx |
| When | Day 3647, on the shore |
| Held by | Me |
| Standing | Kept to date; outstanding until the launch |

The words, as near as I can set them down:

> Let Earth be my witness, and the wide heaven above, and the down-flowing water of the Styx, which is the greatest and most terrible oath for the blessed gods: I am planning no other harm against you. I will think for you what I would think for myself if I were in such need. My mind is fair, and the heart in my breast is not iron; it is kind.

I asked for it before agreeing to build ([[decisions/accept-calypso-release]]). It is the only thing between a goddess's change of mind and a raft at sea.

## What has happened since

- She brought the axe and the adze on day 3648, and the augers on day 3649 ([[ogygia/workshop/tools]]).
- She brought cloth for the sail ([[ogygia/workshop/sail-cloth]]).
- She has put a skin of wine and a skin of water aboard. The bread, the relishes and a second skin of wine are promised for this morning, with a fair wind for the launch ([[ogygia/stores/provisions-aboard]]).

Nothing so far is inconsistent with the oath. The test is today.

See [[people/calypso]] and [[journal/day-3647]]. Filed under [[oaths/_index]].`,
    links: ["decisions/accept-calypso-release.md", "people/calypso.md", "oaths/_index.md", "ogygia/workshop/tools.md", "ogygia/workshop/sail-cloth.md", "ogygia/stores/provisions-aboard.md", "journal/day-3647.md"],
    fields: { day: 3647, swore: "Calypso", by: "Earth, heaven and the Styx", holder: "Odysseus", standing: "kept to date" },
  },
  {
    path: "oaths/circe-no-harm.md",
    title: "Circe's oath on Aeaea",
    type: "oath",
    created: "2017-03-17",
    updated: "2019-05-16",
    status: "kept",
    tags: ["oath", "circe", "aeaea"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "The great oath of the gods, sworn on Hermes's instruction before anything else: that she would plot no further harm against me. Kept, completely, for two years.",
    body: `Hermes's instruction on the path was precise: when she offers her bed, do not refuse it, but first make her swear the great oath of the blessed gods that she will plot no other harm against you, or she will make you weak and unmanned once you are stripped.

She swore it as I asked, and finished it, before anything else happened.

| Field | Entry |
| --- | --- |
| Sworn by | Circe |
| By what | The great oath of the gods |
| Held by | Me |
| Prompted by | Hermes |
| Day | 248 |
| Standing | **Kept** |

## Evidence of keeping

- The twenty-two men ([[crew/aeaea-scouting-party]]) restored the same day, younger and taller than before.
- A year of hospitality, then the truth about the house of the dead ([[decisions/go-to-the-dead]]) when a lie would have kept me longer.
- On day 1038, the route in full and in order ([[voyage/day-1038-circes-route]]). Every hazard named was where she said.

It is the best-kept oath in this folder. It was also extracted under a drawn sword, which I record so that the folder is honest about how oaths with gods get made.

See [[people/circe]], [[people/hermes]], [[voyage/day-248-moly]] and [[decisions/go-to-circe-alone]]. Filed under [[oaths/_index]].`,
    links: ["decisions/go-to-the-dead.md", "people/circe.md", "decisions/go-to-circe-alone.md", "oaths/_index.md", "crew/aeaea-scouting-party.md", "voyage/day-1038-circes-route.md", "people/hermes.md", "voyage/day-248-moly.md"],
    fields: { day: 248, swore: "Circe", by: "the great oath of the gods", holder: "Odysseus", standing: "kept" },
  },
  {
    path: "oaths/xenia-polyphemus.md",
    title: "Guest-right claimed in the cave",
    type: "oath",
    created: "2016-10-17",
    updated: "2016-10-19",
    status: "broken",
    tags: ["oath", "guest-right", "cyclopes"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Claimed the protection owed to strangers under Zeus. Refused outright. His guest-gift was that Nobody would be eaten last.",
    body: `Guest-right ([[knowledge/guest-friendship]]) is not sworn on the day; it is the standing oath every household is held to, under Zeus who watches over strangers and suppliants. I invoked it in the cave in plain terms.

> We are Achaeans, driven off course from Troy. We have come to your knees as suppliants, hoping for a guest-gift. Respect the gods. Zeus avenges strangers.

His answer: the Cyclopes ([[knowledge/cyclopes-customs]]) care nothing for Zeus or the blessed gods, being far stronger; he would not spare us to avoid Zeus's anger, only if he felt like it.

| | |
| --- | --- |
| Invoked by | Me |
| Owed by | Polyphemus |
| Under | Zeus, protector of strangers |
| Standing | **Broken** on the first evening |
| Guest-gift offered | To eat Nobody last |

## What it means for the record

Breaking guest-right does not cancel the grievance that followed. [[people/poseidon]] does not take the view that his son owed us anything. The two claims run side by side and neither discharges the other.

See [[decisions/wait-for-polyphemus]], [[oaths/polyphemus-curse]] and [[people/polyphemus]]. Filed under [[oaths/_index]].`,
    links: ["decisions/wait-for-polyphemus.md", "oaths/polyphemus-curse.md", "people/polyphemus.md", "oaths/_index.md", "knowledge/guest-friendship.md", "knowledge/cyclopes-customs.md", "people/poseidon.md"],
    fields: { day: 97, swore: "standing law", by: "Zeus of strangers", holder: "Odysseus", standing: "broken" },
  },
  {
    path: "oaths/xenia-aeolus.md",
    title: "Guest-friendship of Aeolus",
    type: "oath",
    created: "2016-11-21",
    updated: "2016-12-31",
    status: "withdrawn",
    tags: ["oath", "guest-right", "aeolia"],
    places: ["place:aeolia"],
    summary: "A month as his guest and a gift beyond anything owed. Withdrawn when we came back: he would not help a man the gods had sent back.",
    body: `[[people/aeolus]], son of Hippotas, dear to the gods, lives on a floating island with a wall of unbreakable bronze around it, with his six sons and six daughters.

| Term | Entry |
| --- | --- |
| Host | Aeolus |
| Guest | Me, and the crew of twelve ships |
| Duration | A month |
| Gift | The contrary winds tied in an oxhide bag ([[crew/aeolia-bag]]); the west wind left free |
| Standing | **Withdrawn**, day 172 |

## Kept

He questioned me about Troy and the Argive ships and the homecoming of the Achaeans, and I told it all in order. When I asked to be sent on he did not refuse. The gift was more than guest-right requires of anyone.

## Withdrawn

On our return ([[decisions/return-to-aeolus]]) he ended it:

> Get off my island, quickly, most shameful of living men. It is not right for me to help or send on a man the blessed gods hate.

He was within his rights. Guest-friendship does not oblige a host to go against the gods. I record it as withdrawn, not broken.

## Standing obligations

None either way. Nothing is owed to him and nothing can be asked.

See [[decisions/accept-the-bag-of-winds]] and [[voyage/day-132-aeolia-arrival]]. Filed under [[oaths/_index]].`,
    links: ["decisions/return-to-aeolus.md", "decisions/accept-the-bag-of-winds.md", "oaths/_index.md", "people/aeolus.md", "crew/aeolia-bag.md", "voyage/day-132-aeolia-arrival.md"],
    fields: { day: 132, swore: "Aeolus", by: "guest-friendship", holder: "Odysseus", standing: "withdrawn" },
  },
  {
    path: "oaths/maron-guest-gift.md",
    title: "Pledge with Maron at Ismarus",
    type: "oath",
    created: "2016-07-21",
    updated: "2016-10-18",
    status: "kept",
    tags: ["oath", "guest-right", "ismarus"],
    places: ["place:ismarus"],
    summary: "Protection for the priest's household in exchange for guest-gifts. Both sides kept it the same day, and the wine was used in the cave three months later.",
    body: `An exchange made inside a raid, which is not the usual setting for one.

| | |
| --- | --- |
| Parties | Me; [[people/maron]], son of Euanthes, priest of Apollo |
| My side | His household spared and guarded, out of respect for the god |
| His side | Seven talents of worked gold, a mixing bowl of solid silver, and twelve jars of sweet unmixed wine |
| Witness | Apollo, whose grove it was |
| Standing | **Kept** on both sides |

The wine was the real gift. Maron kept it in his storeroom, known only to himself, his wife and one housekeeper. It is cut one measure to twenty of water and the smell still rises from the bowl ([[crew/ismarus-wine-ration]]).

## Where it went

- One skin of it carried into the cave on day 97, as a gift for whoever lived there ([[voyage/day-97-the-cave]]).
- Three bowls of it given to Polyphemus on day 98, unmixed.
- What remained aboard was lost with the rest at Thrinacia ([[crew/thrinacia-provisions]]).

Recorded as an oath because it was an exchange under a god, and because without it the second night in the cave ends differently.

See [[decisions/spare-maron]] and [[decisions/nobody-as-the-name]]. Filed under [[oaths/_index]].`,
    links: ["decisions/spare-maron.md", "decisions/nobody-as-the-name.md", "oaths/_index.md", "people/maron.md", "crew/ismarus-wine-ration.md", "voyage/day-97-the-cave.md", "crew/thrinacia-provisions.md"],
    fields: { day: 9, swore: "Odysseus and Maron", by: "Apollo", holder: "both", standing: "kept" },
  },
  {
    path: "oaths/promise-to-penelope.md",
    title: "What I promised Penelope at the sailing",
    type: "oath",
    created: "2006-08-01",
    updated: "2026-07-12",
    status: "outstanding",
    tags: ["oath", "penelope", "ithaca"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Not a promise to come back, which I could not give. An instruction: if I did not return, when our son's beard came she should marry whom she chose and leave the house.",
    body: `At the sailing for Troy I took her right hand by the wrist and said, as near as I can remember it after twenty years:

> Wife, I do not think all the Achaeans will come home from Troy unhurt. They say the Trojans are fighters. So I cannot tell whether a god will bring me back or I will be lost there. Everything here is in your care. Look after my father and mother in the hall as you do now, or more so, while I am away. And when you see our son grown and bearded, marry whom you will and leave the house.

| | |
| --- | --- |
| Given by | Me |
| Held by | Penelope |
| Condition | Telemachus grown, and bearded |
| Standing | **Outstanding.** The condition has been met for some years |

## Standing today

The condition is met. Telemachus is a man, gone to Pylos and Sparta on his own authority ([[people/telemachus]]). By the terms I set, she has been free to choose for some years. The suitors in the hall are pressing exactly that point ([[ithaca/suitors/their-case]]).

She has not chosen. The loom bought three years against it ([[people/penelope]], [[ithaca/loom/shroud]]).

My mother is dead ([[people/anticleia]]). My father lives on the upland farm ([[people/laertes]]). Half of the first clause can no longer be kept by anyone.

- [ ] I gave her the release. I have no standing to withdraw it from here, and I will not try to.

Filed under [[oaths/_index]]. See [[ithaca/departure-instructions]] and [[goals/return-to-ithaca]].`,
    links: ["people/telemachus.md", "people/penelope.md", "people/laertes.md", "goals/return-to-ithaca.md", "oaths/_index.md", "ithaca/suitors/their-case.md", "ithaca/loom/shroud.md", "people/anticleia.md", "ithaca/departure-instructions.md"],
    fields: { swore: "Odysseus", by: "his word", holder: "Penelope", standing: "outstanding", confidence: "remembered" },
  },
  {
    path: "oaths/promise-to-elpenor.md",
    title: "Promise to Elpenor",
    type: "oath",
    created: "2018-03-24",
    updated: "2018-03-28",
    status: "kept",
    tags: ["oath", "elpenor", "burial"],
    people: ["person:elpenor"],
    places: ["place:acheron", "place:aeaea"],
    summary: "At the edge of the dead he asked not to be left unwept and unburied. Promised at the pit on day 620; kept on the beach at Aeaea on day 624.",
    body: `He spoke before any other spirit, because he was not yet buried and had not crossed ([[knowledge/order-of-the-shades]]).

> Do not sail off and leave me behind unwept and unburied, or I may become a cause of the gods' anger against you. Burn me with all my armour, heap a barrow for me on the shore of the sea, so that men to come will know of an unlucky man, and fix on the barrow the oar I rowed with while I lived, among my friends.

I answered: *I will do all of this for you, unhappy man.*

| | |
| --- | --- |
| Sworn by | Me |
| To | Elpenor, dead |
| Terms | Burn with his armour; a barrow on the shore; his oar on top |
| Promised | Day 620, at the pit |
| Kept | Day 624, on Aeaea |
| Standing | **Kept** in full |

## The keeping

- [x] Body brought down from Circe's house
- [x] Burned with his armour, on the headland
- [x] Barrow raised, a stone set on it
- [x] His oar fixed on the top ([[crew/barrow-on-aeaea]])

The only promise in this folder made to someone who could do nothing to hold me to it, and the only one that was finished within the week.

See [[decisions/bury-elpenor-first]], [[voyage/day-624-elpenor-buried]], [[crew/elpenor]] and [[crew/promises-to-the-dead]]. Filed under [[oaths/_index]].`,
    links: ["decisions/bury-elpenor-first.md", "crew/elpenor.md", "oaths/_index.md", "knowledge/order-of-the-shades.md", "crew/barrow-on-aeaea.md", "voyage/day-624-elpenor-buried.md", "crew/promises-to-the-dead.md"],
    fields: { day: 620, swore: "Odysseus", by: "his word to the dead", holder: "Elpenor", standing: "kept" },
  },
  {
    path: "oaths/vow-to-the-dead.md",
    title: "Vow to the dead, owed at Ithaca",
    type: "oath",
    created: "2018-03-24",
    updated: "2026-07-12",
    status: "outstanding",
    tags: ["oath", "acheron", "teiresias", "ithaca"],
    people: ["person:teiresias", "person:circe"],
    places: ["place:acheron", "place:ithaca"],
    summary: "Vowed at the pit, as Circe instructed: the best barren heifer in my herds and a pyre of good things for all the dead, and a ram for Teiresias alone. Payable at home.",
    body: `Part of the method Circe gave for calling up the dead ([[knowledge/rites-for-the-dead]]). The vow is made at the pit and paid at home, so it has been outstanding since day 620 ([[voyage/day-620-acheron]]).

| Owed to | What | Where |
| --- | --- | --- |
| All the dead | A barren heifer, the best in the herds, and a pyre heaped with good things | Ithaca |
| Teiresias alone | A ram, the finest in the flock | Ithaca |

| | |
| --- | --- |
| Vowed by | Me |
| Prescribed by | Circe |
| Standing | **Outstanding** |

## A problem with the herds

The vow names *my* herds. As far as news reaches me, the suitors have been eating those herds for four years. Of the estate cattle, 96 of 720 are reported eaten, so most of the herd remains (see [[ithaca/estate]]). There will still be a heifer and a ram if there is still a household. The vow is a second reason to want the herds counted.

## Related

- The method: [[decisions/go-to-the-dead]].
- What Teiresias said once he had drunk: [[knowledge/teiresias-forecast]].
- The other promises made to the dead: [[crew/promises-to-the-dead]].
- The separate obligation he placed on me, to go inland with an oar: [[oaths/teiresias-inland-journey]].

- [ ] Pay on arrival, before anything else is settled in the house.

Filed under [[oaths/_index]].`,
    links: ["ithaca/estate.md", "decisions/go-to-the-dead.md", "knowledge/teiresias-forecast.md", "oaths/teiresias-inland-journey.md", "oaths/_index.md", "knowledge/rites-for-the-dead.md", "voyage/day-620-acheron.md", "crew/promises-to-the-dead.md"],
    fields: { day: 620, swore: "Odysseus", by: "a vow at the pit", holder: "the dead", standing: "outstanding" },
  },
  {
    path: "oaths/teiresias-inland-journey.md",
    title: "The journey inland with an oar",
    type: "oath",
    created: "2018-03-24",
    updated: "2026-07-12",
    status: "outstanding",
    tags: ["oath", "teiresias", "poseidon"],
    people: ["person:teiresias", "person:poseidon"],
    places: ["place:acheron", "place:ithaca"],
    summary: "Not sworn but laid on me: after the house is set in order, walk inland carrying an oar until someone takes it for a winnowing fan, and sacrifice there to Poseidon.",
    body: `[[people/teiresias]] did not ask for a promise. He stated what I would have to do, which in practice is the same thing, and I record it here because an obligation with a god at the end of it belongs in this folder.

> When you have killed the suitors in your halls, take a well-shaped oar and go on until you come to men who do not know the sea and eat no salt with their food. When a traveller meets you and says that you carry a winnowing fan on your shoulder, fix the oar in the ground there and make fine sacrifice to lord Poseidon: a ram, a bull, and a boar that mates with sows. Then go home and offer hecatombs to all the gods, in order.

| | |
| --- | --- |
| Laid on me by | Teiresias |
| Owed to | Poseidon, then all the gods |
| Trigger | After the house is set in order |
| Sign of arrival | Someone mistakes the oar for a winnowing fan |
| Standing | **Outstanding**; not yet due |

## Why it matters now

It is the only stated route to an end of [[people/poseidon]]'s grievance. Everything else in the record is avoidance ([[studies/poseidon-risk]]).

The forecast also says death will come to me gently, away from the sea, in a comfortable old age, with my people prospering around me. That part is not an obligation and is not filed here. See [[knowledge/teiresias-forecast]] and [[studies/forecast-after-the-crossing]].

- [ ] Ask on Ithaca which way inland is furthest from the sea.

Filed under [[oaths/_index]].`,
    links: ["people/poseidon.md", "knowledge/teiresias-forecast.md", "oaths/_index.md", "people/teiresias.md", "studies/poseidon-risk.md", "studies/forecast-after-the-crossing.md"],
    fields: { day: 620, swore: "laid on Odysseus", by: "Teiresias's word", holder: "Poseidon", standing: "outstanding" },
  },
  {
    path: "oaths/sirens-binding-order.md",
    title: "The order at the mast",
    type: "oath",
    created: "2019-05-19",
    updated: "2019-05-19",
    status: "kept",
    tags: ["oath", "sirens", "crew"],
    people: ["person:eurylochus"],
    places: ["place:sirens"],
    summary: "Made the crew promise to bind me tighter if I begged to be let go. I begged. Perimedes and Eurylochus stood up and added rope.",
    body: `An order given in advance against myself, and accepted by the crew as binding on them whatever I said later. It is the only oath in this folder that was designed to be tested.

| | |
| --- | --- |
| Given by | Me |
| Accepted by | The crew of ship 1 |
| Terms | Bind me upright to the mast-step; if I beg or order you to untie me, bind me tighter |
| Tested | Day 1041, within the hour |
| Standing | **Kept** |

## The test

The Sirens' voice reached us across the water. They promised knowledge of everything that happens on the earth. I wanted to listen and signalled the men with my brows to free me. They leaned to the oars and rowed. [[crew/perimedes]] and Eurylochus got up at once and bound me with more rope, tighter than before.

Only when the song could no longer be heard did they take the wax ([[crew/sirens-wax]]) from their ears and untie me.

## Note

The men kept this one perfectly, against my own direct order, because I had told them in advance that my later order was the one to ignore. On Thrinacia they broke an oath in which nobody had told them what to ignore. See [[oaths/helios]].

See [[decisions/hear-the-sirens]], [[voyage/day-1041-sirens]] and [[crew/eurylochus]]. Filed under [[oaths/_index]].`,
    links: ["oaths/helios.md", "decisions/hear-the-sirens.md", "crew/eurylochus.md", "oaths/_index.md", "crew/perimedes.md", "crew/sirens-wax.md", "voyage/day-1041-sirens.md"],
    fields: { day: 1041, swore: "the crew of ship 1", by: "my order", holder: "Odysseus", standing: "kept" },
  },
  {
    path: "oaths/tyndareus-oath.md",
    title: "The oath of Helen's suitors",
    type: "oath",
    created: "2006-08-01",
    updated: "2016-07-12",
    status: "discharged",
    tags: ["oath", "troy", "menelaus"],
    people: ["person:menelaus", "person:penelope"],
    places: ["place:troy", "place:sparta"],
    summary: "My own advice to Tyndareus: make every suitor swear to defend whoever won her. It kept the peace in Sparta and took every one of us to Troy for ten years.",
    body: `Recorded because it is the oath that started the war, and I wrote it.

When the suitors of [[people/helen]] gathered at Tyndareus's house there were too many powerful men to refuse without making enemies of all the rest. I advised him: before the choice, have every suitor swear to defend the marriage of whoever was chosen against anyone who wronged it. In return he spoke for me to his brother [[people/icarius]], and I married [[people/penelope]].

| | |
| --- | --- |
| Sworn by | Every suitor of Helen, me among them |
| To defend | The husband chosen: [[people/menelaus]] |
| Devised by | Me |
| Invoked | When Helen was taken to Troy |
| Standing | **Discharged** on day 0, with the fall of the city |

## The cost of the clause

When it was invoked I tried to stay out of it. It did not work, and I have never written down the details and will not now. I went. So did everyone else who swore.

Ten years at Troy. Ten years coming back. Every name in [[crew/_index]] sailed because of a clause I drafted to win a wife.

## Standing

Discharged. Nobody can call on it again. The war it caused is over; the voyage is not.

Filed under [[oaths/_index]].`,
    links: ["people/penelope.md", "people/menelaus.md", "crew/_index.md", "oaths/_index.md", "people/helen.md", "people/icarius.md"],
    fields: { swore: "Helen's suitors", by: "an oath on a cut victim", holder: "Menelaus", standing: "discharged" },
  },
  {
    path: "oaths/polyphemus-curse.md",
    title: "Polyphemus's prayer to Poseidon",
    type: "oath",
    created: "2016-10-19",
    updated: "2026-07-12",
    status: "in-effect",
    tags: ["oath", "curse", "poseidon", "cyclopes"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes", "place:ithaca"],
    summary: "The counter-oath. Once he had my real name, he prayed to his father that I never reach home, or if I must, late, alone, in another's ship, to trouble in my house.",
    body: `Not an oath I swore, but one sworn against me, and it has been the governing term of the voyage since day 99 ([[voyage/day-99-escape]]). It was only possible because I gave the name: [[decisions/name-at-the-stern]].

> Hear me, Poseidon, earth-holder. If I am truly your son and you are my father, grant that Odysseus, sacker of cities, son of Laertes, whose home is on Ithaca, never reaches home. But if it is his fate to see his people and his well-built house and his own country, let him come late, in a bad way, having lost all his companions, in someone else's ship, and find trouble in his house.

| Clause | Standing |
| --- | --- |
| Never reach home | Not met; not yet failed |
| Late | Met. Ten years |
| In a bad way | Met |
| Having lost all his companions | Met, day 1084. All 600 ([[crew/fleet-strength]]) |
| In someone else's ship | Pending; the raft is mine |
| Trouble in his house | Met, as reported: 108 suitors, four years ([[ithaca/suitors/roster]]) |

| | |
| --- | --- |
| Prayed by | Polyphemus |
| Answered by | Poseidon |
| Standing | **In effect** |

The fallback clauses match the forecast of [[knowledge/teiresias-forecast]] almost word for word. Teiresias did not invent the shape of my homecoming; he read it off this prayer.

See [[people/poseidon]], [[people/polyphemus]] and [[studies/poseidon-risk]]. Filed under [[oaths/_index]].`,
    links: ["decisions/name-at-the-stern.md", "knowledge/teiresias-forecast.md", "people/poseidon.md", "people/polyphemus.md", "oaths/_index.md", "voyage/day-99-escape.md", "crew/fleet-strength.md", "ithaca/suitors/roster.md", "studies/poseidon-risk.md"],
    fields: { day: 99, swore: "Polyphemus", by: "prayer to his father", holder: "Poseidon", standing: "in effect" },
  },

  // -------------------------------------------------------------------- omens
  {
    path: "omens/aulis-serpent.md",
    title: "The serpent at Aulis",
    type: "omen",
    created: "2006-08-20",
    updated: "2016-07-12",
    status: "held",
    tags: ["omen", "troy", "seers"],
    places: ["place:troy"],
    summary: "A serpent came out from under the altar, climbed a plane tree and ate eight sparrow chicks and their mother. Calchas read it as nine years of war, Troy in the tenth. It held.",
    body: `## Observation

At Aulis, before the fleet sailed, we were sacrificing at the altars under a plane tree beside a spring. A serpent came out from under the altar and went straight up the tree to a nest on the highest branch, where there were eight young sparrows and the mother, nine in all. It ate the chicks while they cried, and the mother fluttering round them, and then caught her by the wing and ate her. Then the god who had sent it turned it to stone where it lay.

## Interpretation

[[people/calchas]], at once: as many years as the birds, so many years of fighting there; in the tenth year we take the city.

## Outcome

**Held.** Nine years at Troy, the city taken in the tenth, day 0.

I reminded the army of this omen in the ninth year, when they were ready to launch the ships and go home. It kept them there. Whether that was a service to them is a separate question, and the crew ledger in [[crew/_index]] has an answer to it.

## Note on method

This is the omen I judge the others against: precise count, precise term, read on the spot by a seer, and checkable. Most of the rest of this folder is less clean.

Related: [[people/halitherses]]. Filed under [[omens/_index]].`,
    links: ["crew/_index.md", "omens/_index.md", "people/calchas.md", "people/halitherses.md"],
    fields: { place: "Aulis", source: "Calchas", outcome: "held" },
  },
  {
    path: "omens/heron-in-the-dark.md",
    title: "Heron on the right, at night",
    type: "omen",
    created: "2015-11-04",
    updated: "2015-11-05",
    status: "held",
    tags: ["omen", "troy", "athena"],
    people: ["person:athena"],
    places: ["place:troy"],
    summary: "On the night raid with Diomedes, a heron called on our right hand. Too dark to see it. We took it as Athena's and went on. It held.",
    body: `## Observation

The night [[people/diomedes]] and I went out to scout the Trojan lines, Athena sent a heron close by on our right, along the path. We could not see it in the dark. We heard it cry.

Nothing else: a bird heard, on the right, at the start.

## Interpretation

Mine, on the spot: a sign from [[people/athena]], and a favourable one, because it came on the right. I prayed to her as we went: *stand by me now, as you always have.* Diomedes prayed after me.

## Outcome

**Held.** We took a Trojan scout on the road, learned the disposition of their camp, and came back with the horses of Rhesus, new arrivals from Thrace. Nobody of ours was lost.

## Note on method

This is the first omen in the folder that was **heard and not seen**, and it sets the rule I have kept since: record what reached the senses and nothing else. I did not see a heron. I heard one, and say so.

The existing record for day 3646 ([[omens/day-3646-hawk]]) follows the same rule and does not interpret at all. That is the stricter form, and probably the better one.

See [[knowledge/athena-favour]]. Filed under [[omens/_index]].`,
    links: ["people/athena.md", "omens/day-3646-hawk.md", "omens/_index.md", "people/diomedes.md", "knowledge/athena-favour.md"],
    fields: { place: "Troy", source: "observed", outcome: "held" },
  },
  {
    path: "omens/day-21-malea-wind.md",
    title: "North wind and current at Malea",
    type: "omen",
    created: "2016-08-02",
    updated: "2016-08-11",
    status: "held",
    tags: ["omen", "sea", "malea"],
    places: ["place:malea"],
    summary: "Rounding the cape with home one day's sail beyond it, the current and a north wind took hold together. Read as weather. It was not only weather.",
    body: `## Observation

Day 21 ([[voyage/day-21-cape-malea]]). Doubling Cape Malea, the last turn before an easy run up the west coast to Ithaca. The current set hard against us and a north wind ([[knowledge/boreas]]) came on at the same time. Sails torn; we beached and lay two days and nights, then raised the masts and sailed again. As we came round the cape the wind and the swell caught us once more and pushed us off past Cythera, into open sea.

## Interpretation

At the time: weather. Malea is known for it. I logged it as a navigational problem, not a sign.

In hindsight, two observations do not fit weather alone:

1. The wind and current joined at the one point where home was a day's sail beyond.
2. Nine days of it, steady, from one quarter.

## Outcome

**Held**, in the sense that the reading I gave it at the time was wrong and the wind meant what wind sometimes means. Nine days lost, and the voyage moved off every chart we had. The next landfall was the lotus country ([[decisions/drag-back-the-lotus-eaters]]).

## Note

Malea is a sea sign recorded after the fact. That makes it weaker evidence than one recorded before. It stays in the folder because the pattern it begins does not end until Ogygia.

Filed under [[omens/_index]]. See [[voyage/legs/cape-malea]] and [[voyage/_index]].`,
    links: ["decisions/drag-back-the-lotus-eaters.md", "voyage/_index.md", "omens/_index.md", "voyage/day-21-cape-malea.md", "knowledge/boreas.md", "voyage/legs/cape-malea.md"],
    fields: { day: 21, place: "Cape Malea", source: "observed", outcome: "held" },
  },
  {
    path: "omens/day-99-ram-refused.md",
    title: "The ram on the beach, not accepted",
    type: "omen",
    created: "2016-10-19",
    updated: "2019-07-01",
    status: "held",
    tags: ["omen", "cyclopes", "sacrifice"],
    places: ["place:cyclopes"],
    summary: "The crew gave me the leading ram of Polyphemus's flock as my share. I burned its thighs for Zeus on the beach. He did not accept the sacrifice. I did not know that until later.",
    body: `## Observation

Back on the goat island after the escape, we divided the Cyclops's flock fairly. The crew gave me the great ram, the one I had come out under, as a share apart. I sacrificed it on the shore to [[people/zeus]], son of Cronos, who rules all, and burned the thigh pieces ([[knowledge/sacrifice-procedure]]).

We feasted until sunset and slept on the beach. There was nothing remarkable about the smoke or the fire. Nothing was seen.

## Interpretation

At the time: none. A sacrifice made properly, a fair division, an escape. I took it as closing the episode.

## Outcome

**Held**, read later. Zeus did not accept the offering. He was already considering how all the well-benched ships and my trusted companions might be destroyed. I know this now; I did not then. Every ship and every man named in [[crew/_index]] was gone within three years.

## Note on method

An omen recorded with no observation at all, only an outcome. It is in the folder because it was the moment the voyage turned and I did not notice. A sacrifice that looks accepted and is not leaves no sign at all, and I have no way of telling the two apart.

See [[decisions/name-at-the-stern]], made the same morning, and [[voyage/day-99-escape]]. Filed under [[omens/_index]].`,
    links: ["crew/_index.md", "decisions/name-at-the-stern.md", "omens/_index.md", "people/zeus.md", "knowledge/sacrifice-procedure.md", "voyage/day-99-escape.md"],
    fields: { day: 99, place: "the goat island", source: "observed", outcome: "held" },
  },
  {
    path: "omens/day-172-aeolus-reading.md",
    title: "Aeolus reads the return",
    type: "omen",
    created: "2016-12-31",
    updated: "2016-12-31",
    status: "held",
    tags: ["omen", "aeolia", "gods"],
    places: ["place:aeolia"],
    summary: "A ship sent home on a god's wind and blown back to the sender. Aeolus read it as proof that the gods hated me. Unwelcome, and correct.",
    body: `## Observation

The event itself, not a bird or a sound: a ship given every advantage a wind-keeper can give, within sight of home, returned to the island it left. Not wrecked. Returned.

## Interpretation

Not mine. [[people/aeolus]]'s, given to my face in his own hall:

> It is not right for me to help or send on a man the blessed gods hate. Go, since you have come here hated by the immortals.

He did not say which god. He did not need to.

## Outcome

**Held.** At the time I had not connected the name at the stern with anything that followed. Aeolus connected the return with a god's anger without knowing about the stern at all. Both of us were right; he got there first.

Since then: the Laestrygonians, Circe, the dead, the strait, the cattle, the storm. Poseidon's grievance (see [[people/poseidon]]) and later [[people/helios]]'s were both live.

## Note on method

This is the first time anyone read the voyage as a whole rather than one landfall at a time. A host with nothing to gain told me something I did not want to hear. That is the best kind of source and it is rare.

See [[decisions/return-to-aeolus]], [[oaths/xenia-aeolus]] and [[journal/day-172]]. Filed under [[omens/_index]].`,
    links: ["people/poseidon.md", "decisions/return-to-aeolus.md", "oaths/xenia-aeolus.md", "omens/_index.md", "people/aeolus.md", "people/helios.md", "journal/day-172.md"],
    fields: { day: 172, place: "Aeolia", source: "Aeolus", outcome: "held" },
  },
  {
    path: "omens/day-246-the-stag.md",
    title: "The stag on the path",
    type: "omen",
    created: "2017-03-15",
    updated: "2017-03-15",
    status: "held",
    tags: ["omen", "aeaea", "provisions"],
    places: ["place:aeaea"],
    summary: "Climbing to look over the island, a great stag came down across my path to drink at the river. One spear. Food for a crew that had stopped eating.",
    body: `## Observation

First day on Aeaea, after we had beached. I took a spear and a sword and climbed a lookout to see if there were people. I saw smoke rising through the oak woods from the middle of the island ([[knowledge/reading-a-coast]]).

On the way back to the ship, as I came near, a great stag with high antlers came out of the woods across my path, going down to the river to drink, with the heat of the sun on it. I struck it in the spine near the middle of the back, and the bronze spear went through, and it fell in the dust.

Its size: I tied its legs with a rope of twisted willow and carried it on my neck, leaning on the spear, because it was too large to carry on one shoulder with one hand.

## Interpretation

Mine: some god took pity on me in my loneliness and sent it across my path. Not a message, a provision.

## Outcome

**Held.** We ate all day on the beach, and the men, who had stopped eating after the Laestrygonians ([[crew/losses/laestrygonians]]), came back to themselves. The next morning I could ask them to do something difficult: [[decisions/split-the-crew-on-aeaea]].

## Note

The smoke was the more important observation that morning, and I recorded it second. Keep both in this order; it is how it happened.

Filed under [[omens/_index]]. See [[voyage/day-246-aeaea-arrival]] and [[crew/_index]].`,
    links: ["decisions/split-the-crew-on-aeaea.md", "crew/_index.md", "omens/_index.md", "knowledge/reading-a-coast.md", "crew/losses/laestrygonians.md", "voyage/day-246-aeaea-arrival.md"],
    fields: { day: 246, place: "Aeaea", source: "observed", outcome: "held" },
  },
  {
    path: "omens/day-1041-calm.md",
    title: "A calm before the Sirens",
    type: "omen",
    created: "2019-05-19",
    updated: "2019-05-19",
    status: "held",
    tags: ["omen", "sea", "sirens"],
    places: ["place:sirens"],
    summary: "As the ship came near the Sirens' island the wind dropped to nothing and the sea went flat. Some power had laid the waves. We rowed.",
    body: `## Observation

Day 1041, mid-morning. A good wind behind us out of Aeaea, sent by [[people/circe]], carrying the ship well. As we came near the Sirens' island it stopped all at once. Dead calm. No wave anywhere. The men stood up, furled the sail, stowed it, sat to the oars and churned the water with the fir blades.

That is the whole of what was observed: a fair wind that stopped exactly where we would have been driven fastest past the danger.

## Interpretation

Two readings were available on the deck:

- **Bad:** a calm leaves a ship at the mercy of whatever is singing.
- **Good:** a calm means rowers, and rowers with wax in their ears do not need to hear an order to keep time.

I took the second, because the wax was already in ([[crew/sirens-wax]]).

## Outcome

**Held**, in the second reading. A sailing ship in a wind would have gone where the wind went. A rowed ship goes where the stroke goes, and the stroke did not change. See [[voyage/day-1041-sirens]], which calls this the only luck of the whole passage.

## Note

Some divine power had laid the waves. Whose, I do not know, and I have not guessed in the record.

See [[knowledge/sirens]] and [[voyage/legs/sirens]]. Filed under [[omens/_index]].`,
    links: ["voyage/day-1041-sirens.md", "knowledge/sirens.md", "omens/_index.md", "people/circe.md", "crew/sirens-wax.md", "voyage/legs/sirens.md"],
    fields: { day: 1041, place: "the Sirens", source: "observed", outcome: "held" },
  },
  {
    path: "omens/day-1078-hides-crawled.md",
    title: "The hides crawled",
    type: "omen",
    created: "2019-06-25",
    updated: "2019-07-01",
    status: "held",
    tags: ["omen", "thrinacia", "helios"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "During the feast on the cattle of the Sun, the flayed hides crept along the ground and the meat on the spits lowed, raw and roasted alike.",
    body: `## Observation

Second day of the feasting on Thrinacia. The gods showed signs to the crew at once:

- The hides of the slaughtered cattle crawled along the ground.
- The meat on the spits lowed, both the roasted and the raw.
- The sound was the sound of cattle.

Every man saw and heard it. Nobody stopped eating.

## Interpretation

There was only one reading and it did not need a seer. The herds ([[knowledge/thrinacia-cattle]]) belonged to [[people/helios]]; the oath had been sworn on the island ([[oaths/helios]]); the condition in the forecast was the cattle and only the cattle ([[knowledge/teiresias-forecast]]).

I had already said it, with the smell of the roasting coming down to the ship on the first day ([[voyage/day-1077-the-cattle]]). After this I said nothing further, because there was nothing further that would change anything.

## Outcome

**Held.** Six days of feasting ([[voyage/day-1083-sixth-day]]). On the seventh the wind dropped and we sailed. Within the day Zeus broke the ship: [[omens/day-1084-thunder]].

## Note on method

The clearest omen in this folder, and the one that made no difference. A sign does nothing for a crew that has already decided. Recorded so that I do not later tell myself the gods gave no warning.

See [[decisions/cattle-of-helios]]. Filed under [[omens/_index]].`,
    links: ["oaths/helios.md", "knowledge/teiresias-forecast.md", "omens/day-1084-thunder.md", "decisions/cattle-of-helios.md", "omens/_index.md", "knowledge/thrinacia-cattle.md", "people/helios.md", "voyage/day-1077-the-cattle.md", "voyage/day-1083-sixth-day.md"],
    fields: { day: 1078, place: "Thrinacia", source: "observed", outcome: "held" },
  },
  {
    path: "omens/day-1084-thunder.md",
    title: "Thunder, and the ship struck",
    type: "omen",
    created: "2019-07-01",
    updated: "2019-07-02",
    status: "held",
    tags: ["omen", "thrinacia", "zeus", "losses"],
    places: ["place:thrinacia"],
    summary: "Out of sight of land a cloud stood over the ship. Then the west wind, the mast down, and thunder and the bolt together. Sulphur, and every man in the water.",
    body: `## Observation

Day 1084, first day out of Thrinacia, when the island had dropped astern and there was nothing but sky and sea:

1. A dark cloud stood still directly over the ship and the sea beneath it darkened.
2. The west wind came shrieking in a sudden squall and snapped both forestays ([[knowledge/mast-stepping]]).
3. The mast fell aft into the bilge, struck the helmsman ([[crew/helmsmen]]) on the head and smashed his skull. He went off the stern like a diver.
4. Zeus thundered and struck the ship with lightning at the same moment.
5. The ship spun, full of sulphur smoke.
6. The men fell out of her and rode the waves round her like sea-crows, and the god took away their homecoming.

## Interpretation

None needed. This is the consequence the forecast set for the cattle, delivered by the god whose law the oath invoked.

## Outcome

**Held.** 31 lost ([[crew/losses/thrinacia]]), every remaining man of ship 1. No ship returned. The crew ledger closes here at 600 lost of 600 embarked, and [[crew/_index]] has the full count.

I lashed the mast and keel together and rode them. The next record is [[decisions/hold-the-fig-tree]].

## Note

Thunder is the commonest sign there is. This was not a sign; it was the sentence. Kept in this folder because of the order of the observations, which I want preserved exactly as it happened.

See [[omens/day-1078-hides-crawled]], [[decisions/cattle-of-helios]] and [[voyage/day-1084-the-storm]]. Filed under [[omens/_index]].`,
    links: ["crew/_index.md", "decisions/hold-the-fig-tree.md", "omens/day-1078-hides-crawled.md", "decisions/cattle-of-helios.md", "omens/_index.md", "knowledge/mast-stepping.md", "crew/helmsmen.md", "crew/losses/thrinacia.md", "voyage/day-1084-the-storm.md"],
    fields: { day: 1084, place: "at sea off Thrinacia", cost: "31 men", outcome: "held" },
  },
  {
    path: "omens/day-3644-two-eagles.md",
    title: "Two eagles over the assembly",
    type: "omen",
    created: "2026-07-04",
    updated: "2026-07-11",
    status: "open",
    tags: ["omen", "ithaca", "birds"],
    people: ["person:telemachus", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Reported: when Telemachus called the assembly, two eagles flew down from the mountain on the wind, wheeled over the crowd, and tore at each other before going off to the right.",
    body: `**Reported, not seen.** Filed as received. The assembly was held on day 3642; the report arrived on day 3644.

## Observation (as reported)

When [[people/telemachus]] called the first assembly on Ithaca since I sailed ([[ithaca/telemachus/assembly]]), and spoke against the suitors, two eagles came down from the mountain, gliding side by side on the wind with their wings spread. Over the middle of the assembly they began to wheel, beating their wings, and looked down on the heads of the crowd. Then they tore at each other's heads and necks with their talons and went off to the right, over the houses of the town.

## Interpretation (as reported)

[[people/halitherses]], son of Mastor, the old man best at reading birds, stood up and said: Odysseus will not be away from his family much longer; he is already near, planning death for all of them. He added that he had said as much when I sailed: that I would come home in the twentieth year, unrecognised, having lost all my companions.

[[people/eurymachus]], for the suitors, answered that many birds fly about under the sun and not all of them mean anything.

## Outcome

**Open.** Two of Halitherses's clauses (the twentieth year, all companions lost) are matched by the record as it stands. Whether I am "near" depends on a raft that has not been launched.

## Note

Telemachus left for Pylos soon afterwards ([[ithaca/news/day-3644-assembly]]). See also [[omens/day-3651-eagle]] and [[people/antinous]].

Filed under [[omens/_index]].`,
    links: ["people/telemachus.md", "omens/day-3651-eagle.md", "people/antinous.md", "omens/_index.md", "ithaca/telemachus/assembly.md", "people/halitherses.md", "people/eurymachus.md", "ithaca/news/day-3644-assembly.md"],
    fields: { day: 3644, event_day: 3642, place: "Ithaca", source: "Halitherses", confidence: "reported", outcome: "open" },
  },
  {
    path: "omens/day-3648-sneeze.md",
    title: "A sneeze at the first tree",
    type: "omen",
    created: "2026-07-08",
    updated: "2026-07-08",
    status: "open",
    tags: ["omen", "ogygia", "raft"],
    places: ["place:ogygia"],
    summary: "Said aloud, as the first of the twenty trees came down, that it would carry me home. Sneezed on the last word. Filed because at home it would be taken as an answer.",
    body: `## Observation

Day 3648, mid-morning, at the end of the island where the tall trees grow. The first fir came down cleanly ([[ogygia/build/timber-log]]). I said aloud, to nobody, that it would carry me home. I sneezed on the last word.

That is all. No bird, no sound but the tree and me.

## Interpretation

On Ithaca a sneeze that falls on a spoken wish is taken as the gods agreeing to it. My father ([[people/laertes]]) took it so; so did the old women in the house when I was a boy. It is the smallest of the signs and nobody pays a seer for it.

Against that: it was a cold morning in the shade of the trees, and there was sawdust.

| Reading | Weight |
| --- | --- |
| Assent to the wish | Custom |
| Sawdust | Sawdust |

## Outcome

**Open.** The wish is not yet tested. The raft was finished on day 3651 ([[voyage/ogygia/raft]]); the crossing starts today.

## Note on method

Filed under the same rule as everything else here: observation, then interpretation, then outcome, and the outcome left open until there is one. It would be easy to leave this out because it is small. Small signs are the ones that get remembered selectively afterwards, which is the reason to write them down when they happen.

Filed under [[omens/_index]]. See [[ogygia/build/day-3648-felling]], [[journal/day-3648]] and [[ogygia/_index]].`,
    links: ["voyage/ogygia/raft.md", "ogygia/_index.md", "omens/_index.md", "ogygia/build/timber-log.md", "people/laertes.md", "ogygia/build/day-3648-felling.md", "journal/day-3648.md"],
    fields: { day: 3648, place: "Ogygia", source: "observed", outcome: "open" },
  },
  {
    path: "omens/day-3649-sister-dream.md",
    title: "Penelope's dream of her sister",
    type: "omen",
    created: "2026-07-09",
    updated: "2026-07-11",
    status: "open",
    tags: ["omen", "ithaca", "dream", "penelope"],
    people: ["person:penelope", "person:telemachus", "person:athena"],
    places: ["place:ithaca"],
    summary: "Reported: a figure in the likeness of her sister Iphthime stood at Penelope's head and told her the boy would come home safe. Asked about me, it would not say.",
    body: `**Reported, not seen.** Filed as received, second-hand.

## Observation (as reported)

The night after she learned that the suitors had a ship waiting in the strait for [[people/telemachus]], [[people/penelope]] went upstairs without eating and lay awake until sleep took her. A figure came into the room through the slot by the door-bolt and stood at her head. It had the likeness of her sister Iphthime, who married Eumelus and lives in Pherae.

It told her not to grieve: the boy would still come home, since he had done nothing wrong in the eyes of the gods. It said it had been sent by [[people/athena]], who pitied her.

She asked it whether I was alive or dead. It said it would not tell her either way; it is bad to speak words like wind.

## Interpretation

Hers, as reported: comforted about the son. On the other question it gave her nothing, and said so.

Mine: the refusal is the most exact part of the dream. Nobody on Ithaca has firm news of me. Nobody should.

## Outcome

**Open** on Telemachus: the ambush ship ([[ithaca/suitors/ambush-ship]]) is still reported in the strait. **Open** on the other question, by the dream's own refusal.

## Note

A dream-figure sent by a god in someone else's likeness is the hardest kind of source to weigh. Filed with its source chain written out, as every reported record here should be.

Filed under [[omens/_index]]. See [[ithaca/news/day-3648-medon]], [[ithaca/telemachus/return-risk]] and [[ithaca/_index]].`,
    links: ["people/telemachus.md", "people/penelope.md", "people/athena.md", "ithaca/_index.md", "omens/_index.md", "ithaca/suitors/ambush-ship.md", "ithaca/news/day-3648-medon.md", "ithaca/telemachus/return-risk.md"],
    fields: { day: 3649, place: "Ithaca", source: "a dream-figure", confidence: "reported", outcome: "open" },
  },
  {
    path: "omens/day-3650-the-bear.md",
    title: "The Bear does not set",
    type: "omen",
    created: "2026-07-10",
    updated: "2026-07-12",
    status: "open",
    tags: ["omen", "stars", "navigation"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Watched the Bear through a whole night from the beach. It turned in one place and did not go down. Calypso's directions rest on that, and so does the crossing.",
    body: `## Observation

Night of day 3650, from the beach beside the raft, clear sky, no moon to speak of. I watched the Bear ([[knowledge/great-bear]]) from dusk until first light.

- It turned about one point and stayed in the north.
- It did not touch the sea at any hour.
- [[knowledge/orion]] rose in the east and the Bear kept its face towards him, as she said it would.
- The Pleiades were up before dawn. Boötes was slow to set.

## Interpretation

Not an omen in the sense of a message. A sign in the older sense: a mark that something can be steered by. Calypso's words ([[ogygia/build/sailing-directions]]) were that alone of the stars it has no share in the baths of Ocean. Seen for myself on this night, it does not.

I have filed it here and not in knowledge because it was the observation that made me trust a set of directions from a goddess who, until four days ago, had every reason to keep me.

## Outcome

**Open.** The method is adopted at [[decisions/sail-by-the-bear]]: keep it on the left hand, east of north, seventeen nights. It holds if the sky does.

- [ ] Log the Bear's height above the sea each night of the crossing.
- [ ] Note any night it cannot be seen, and what was steered by instead.

See [[people/calypso]] and [[decisions/leave-today]]. Filed under [[omens/_index]].`,
    links: ["decisions/sail-by-the-bear.md", "people/calypso.md", "decisions/leave-today.md", "omens/_index.md", "knowledge/great-bear.md", "knowledge/orion.md", "ogygia/build/sailing-directions.md"],
    fields: { day: 3650, place: "Ogygia", source: "observed", outcome: "open" },
  },
  {
    path: "omens/day-3652-dawn-wind.md",
    title: "Wind at first light, offshore",
    type: "omen",
    created: "2026-07-12",
    updated: "2026-07-12",
    status: "open",
    tags: ["omen", "ogygia", "wind", "departure"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:calypso-cave"],
    summary: "This morning, before the launch: a light wind off the land, steady, warm, from astern of the heading. She promised a fair wind. This may be it.",
    body: `**Logged at 06:40, before launch.** Nothing below has been tested.

## Observation

- First light on the beach below the cave ([[ogygia/island/shore]]).
- Wind off the land, light and steady, no gusts.
- Warm, not the night wind.
- From astern of the planned heading, so that the sail would fill without tacking.
- The sea inshore is flat. Further out there is a long, low swell from the north-west that has been there for three days ([[ogygia/weather/last-weeks]]).

## Interpretation

Calypso said she would send a fair wind behind me, warm and gentle, to carry me safe to my own country, if the gods who hold the wide sky are willing. This fits her description on every point but the last, which nobody can check from a beach.

Also possible: a land breeze at dawn, of the ordinary kind, which will die by mid-morning and leave a raft in a calm.

| Reading | Test |
| --- | --- |
| Her wind | Still blowing at noon, still from astern |
| A land breeze | Gone by mid-morning |

## Outcome

**Open.** Check at noon and record the result here, whichever it is. Under her oath ([[oaths/calypso-no-harm]]) the wind should not turn on me by her doing. The oath does not bind anyone else's wind.

- [ ] Note at noon: wind direction, strength, distance off.

See [[decisions/leave-today]], [[ogygia/weather/launch-window]] and [[journal/day-3652]]. Filed under [[omens/_index]].`,
    links: ["oaths/calypso-no-harm.md", "decisions/leave-today.md", "journal/day-3652.md", "omens/_index.md", "ogygia/island/shore.md", "ogygia/weather/last-weeks.md", "ogygia/weather/launch-window.md"],
    fields: { day: 3652, place: "Ogygia", source: "observed", outcome: "open" },
  },
];
