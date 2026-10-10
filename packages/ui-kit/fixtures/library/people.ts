// Library domain: people. See ../README.md and ./types.ts.
//
// Contact and relationship records for everyone Odysseus knows, or knows of,
// as of day 3652: the household, the hall, the shades met at the Acheron, the
// gods, the kings of the fleet and the hosts of the voyage. Each record keeps
// its standing, the date its last news arrived, and whether it was seen or
// only reported. The fixture cast (people.ts) is not restated here.

import type { LibraryDocument } from "./types.js";

export const peopleDocuments: LibraryDocument[] = [
  // ------------------------------------------------------------ the shades
  {
    path: "people/anticleia.md",
    title: "Anticleia",
    type: "shade",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "closed",
    tags: ["shades", "household", "acheron"],
    people: ["person:laertes", "person:penelope", "person:telemachus"],
    places: ["place:acheron", "place:ithaca"],
    summary: "Mother. Alive at the sailing; met among the dead on day 620. Died of missing me.",
    body: `## Relationship

Mother. Daughter of Autolycus. She was alive when the ships left for Troy, and I did not know she had died until she came to the pit at the Acheron ([[voyage/day-620-acheron]]) and would not drink until Teiresias had spoken.

She told me what killed her. Not sickness, not the archer's arrows: missing me, and wondering what had become of me. I tried three times to hold her and three times there was nothing to hold.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Mother | Among the dead | Dead | 2018-03-24, seen |

What she reported, as true on day 620: [[people/penelope]] waiting in the house and weeping; [[people/telemachus]] holding the lands without challenge; [[people/laertes]] on the upland farm, sleeping in the ashes by the fire in winter. Two of those three have since changed. The third has not.

## Outstanding

Nothing can be paid to her. What is owed is to Laertes: he should hear how she died from me, not from the island.

Filed under [[people/_index]]. See also [[people/autolycus]], [[ithaca/household/anticleia]], [[journal/day-621]] and [[knowledge/order-of-the-shades]].`,
    links: ["people/_index.md", "people/penelope.md", "people/telemachus.md", "people/laertes.md", "people/autolycus.md", "voyage/day-620-acheron.md", "ithaca/household/anticleia.md", "journal/day-621.md", "knowledge/order-of-the-shades.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/agamemnon.md",
    title: "Agamemnon",
    type: "shade",
    created: "2018-03-24",
    updated: "2026-07-06",
    status: "closed",
    tags: ["shades", "fleet", "acheron", "warning"],
    people: ["person:menelaus", "person:penelope"],
    places: ["place:acheron", "place:troy"],
    summary: "Commander at Troy. Murdered at his own table on coming home. His advice: land in secret.",
    body: `## Relationship

Commander of the army at Troy, brother of [[people/menelaus]]. Ten years of councils with him, most of them arguments. He reached home before any of us and was killed at the feast laid for his return, by [[people/aegisthus]] with [[people/clytemnestra]]'s help. His men died with him.

At the pit ([[voyage/day-620-acheron]]) he wept and reached out with hands that had no strength left in them.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Commander, Troy | Among the dead | Dead | 2018-03-24, seen |

> Bring your ship in to your own country secretly, not in the open. There is no trusting women any more.

He excepted [[people/penelope]] from that in the same breath, and said so twice. The first half of the advice is the part to keep; see [[knowledge/order-of-the-shades]].

## Outstanding

- [x] Asked after his son. I had no news then.
- [ ] News since (Pylos, reported 2026-07-06): [[people/orestes]] has avenged him. There is no way to tell him.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/menelaus.md", "people/aegisthus.md", "people/clytemnestra.md", "people/penelope.md", "people/orestes.md", "voyage/day-620-acheron.md", "knowledge/order-of-the-shades.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/achilles.md",
    title: "Achilles",
    type: "shade",
    created: "2018-03-24",
    updated: "2026-07-06",
    status: "closed",
    tags: ["shades", "fleet", "acheron"],
    places: ["place:acheron", "place:troy"],
    summary: "Best of the army at Troy. Among the dead he would rather be a hired hand above ground.",
    body: `## Relationship

Fetched him from his mother's hiding place before the war, and fought beside him until the arrow. The armour that was his was voted to me afterwards, which is the reason [[people/ajax-son-of-telamon]] will not speak to me.

At the pit ([[voyage/day-620-acheron]]) I told him he was honoured among the dead as he had been among the living. He would not have it:

> I would rather work the land as another man's hired hand, with no land of my own, than be lord over all the dead.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Commander of the Myrmidons | Among the dead | Dead | 2018-03-24, seen |

He came with [[people/patroclus]] and [[people/antilochus]]. The order they came in: [[knowledge/order-of-the-shades]].

## Outstanding

He asked two things. I could answer one.

- [x] His son: told him [[people/neoptolemus]] fought in the front rank, was in the horse without trembling, and left Troy unhurt with his share. He went off across the meadow pleased.
- [ ] His father: no news of [[people/peleus]] then, and none since.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/ajax-son-of-telamon.md", "people/patroclus.md", "people/antilochus.md", "people/neoptolemus.md", "people/peleus.md", "voyage/day-620-acheron.md", "knowledge/order-of-the-shades.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/ajax-son-of-telamon.md",
    title: "Ajax, son of Telamon",
    type: "shade",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "unresolved",
    tags: ["shades", "fleet", "grievance"],
    places: ["place:acheron", "place:troy"],
    summary: "Lost the vote for Achilles' armour to me and died of it. Would not answer at the pit.",
    body: `## Relationship

The best fighter at Troy after [[people/achilles]], and the one who carried his body out. When the armour was put to a judgement it was given to me. He took his own life over it.

At the pit ([[voyage/day-620-acheron]]) he stood apart. I spoke to him as gently as I know how: that I wished the contest had never been held, that the army mourned him as it mourned Achilles, that the blame lay with Zeus. He gave no answer and went away into the dark after the other dead.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Commander, Salamis | Among the dead | Dead; grievance held | 2018-03-24, seen |

## Outstanding

An apology was made and not accepted. That is the whole entry. There is nothing further that can be offered to the dead, and I do not expect to stand at that pit again.

He is the only grievance in this file that I think he is entitled to.

Filed under [[people/_index]]. See [[knowledge/order-of-the-shades]].`,
    links: ["people/_index.md", "people/achilles.md", "voyage/day-620-acheron.md", "knowledge/order-of-the-shades.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/heracles.md",
    title: "Heracles",
    type: "shade",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "closed",
    tags: ["shades", "acheron"],
    places: ["place:acheron"],
    summary: "His image walks among the dead with an arrow on the string; the man himself is with the gods.",
    body: `Not a contact. One conversation, which he started.

## Relationship

What came to the pit was his image, bow bare and an arrow on the string, the dead scattering round him like birds. The man himself, I am told, feasts with the gods. He knew me on sight and spoke first: he took me for a man carrying the same kind of load he had carried, laboured out under a lesser master. He said he had once been sent down here himself, to bring the hound back up, and had done it.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Hero | Image among the dead | Dead (image only) | 2018-03-24, seen |

## Note

The only one at the pit who asked nothing. He said I had a hard time ahead and he was right. He was the last I spoke with at the pit on day 620 ([[voyage/day-620-acheron]]). When the rest of the dead came up in their thousands on day 622, I left ([[voyage/day-622-leaving-the-dead]]), and I would do the same again.

Filed under [[people/_index]]. The visit itself: [[people/teiresias]] and [[voyage/legs/house-of-the-dead]].`,
    links: ["people/_index.md", "people/teiresias.md", "voyage/day-620-acheron.md", "voyage/day-622-leaving-the-dead.md", "voyage/legs/house-of-the-dead.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/patroclus.md",
    title: "Patroclus",
    type: "shade",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "closed",
    tags: ["shades", "fleet"],
    places: ["place:acheron", "place:troy"],
    summary: "Achilles' companion, killed at Troy. Came to the pit beside him and did not speak to me.",
    body: `## Relationship

Companion of [[people/achilles]] from boyhood, killed by Hector before the walls in the armour he had borrowed. I was in the fighting over his body. He and Achilles are buried in the one urn on the headland, as Achilles asked.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Companion of Achilles | Among the dead | Dead | 2018-03-24, seen |

He came up to the pit ([[voyage/day-620-acheron]]) with Achilles and [[people/antilochus]]. He did not drink and did not speak; only Achilles did.

## Outstanding

Nothing owed. Recorded so the list of those I saw ([[knowledge/order-of-the-shades]]) is complete, because the list is what I would be asked for at Pylos or Sparta, and I would rather read it than remember it.

- [ ] If [[people/nestor]] ever asks who walked with his son among the dead: Patroclus and Achilles.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/achilles.md", "people/antilochus.md", "people/nestor.md", "voyage/day-620-acheron.md", "knowledge/order-of-the-shades.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/antilochus.md",
    title: "Antilochus",
    type: "shade",
    created: "2018-03-24",
    updated: "2026-07-06",
    status: "active",
    tags: ["shades", "fleet", "pylos"],
    people: ["person:nestor"],
    places: ["place:acheron", "place:pylos"],
    summary: "Nestor's son, killed at Troy. Seen among the dead with Achilles; his father may not know that.",
    body: `## Relationship

Son of [[people/nestor]], the fastest runner in the army and among the steadiest. Killed at Troy by Memnon, defending his father. I knew him the whole ten years.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Son of Nestor | Among the dead | Dead | 2018-03-24, seen |

He came to the pit ([[voyage/day-620-acheron]]) in [[people/achilles]]' company, with [[people/patroclus]]. That is the whole observation. He did not speak to me.

## Outstanding

This is the one record among the shades that carries something I could still deliver.

- [ ] Tell Nestor his son was seen among the dead in the best company there is. Nestor still grieves him: reported from Pylos (2026-07-06, [[ithaca/news/day-3646-pylos]]) that he named him when [[people/telemachus]] asked about the war.
- [ ] Do it in person. Not in a message.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/nestor.md", "people/achilles.md", "people/patroclus.md", "people/telemachus.md", "voyage/day-620-acheron.md", "ithaca/news/day-3646-pylos.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2026-07-06", day: 620 },
  },
  {
    path: "people/minos.md",
    title: "Minos",
    type: "shade",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "closed",
    tags: ["shades", "acheron"],
    places: ["place:acheron"],
    summary: "Seen at a distance among the dead, holding judgement over them. Not spoken to.",
    body: `Observed, not met.

## Relationship

None. Son of Zeus, once king in Crete, and grandfather of [[people/idomeneus]]. At the Acheron ([[voyage/legs/house-of-the-dead]]) I saw him seated with a sceptre, giving judgements to the dead, who stood and sat about him in the wide-gated house putting their cases.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Judge of the dead | Among the dead | Dead; still sitting | 2018-03-24, seen |

## Note

Filed because it was the one orderly thing I saw down there: a man hearing cases, one after another, with the dead waiting their turn. It looked like any court on any island, and I noticed that it made me feel better and I do not entirely know why.

Seen in the same hour: [[people/sisyphus]], [[people/tantalus]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/idomeneus.md", "people/sisyphus.md", "people/tantalus.md", "voyage/legs/house-of-the-dead.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/sisyphus.md",
    title: "Sisyphus",
    type: "shade",
    created: "2018-03-24",
    updated: "2018-03-24",
    status: "closed",
    tags: ["shades", "acheron"],
    places: ["place:acheron"],
    summary: "Seen among the dead pushing a stone uphill that rolls back down before the top.",
    body: `Observed, not met.

## Relationship

None. I saw him at the Acheron ([[voyage/legs/house-of-the-dead]]), braced with hands and feet, shoving an enormous stone up a hill. Each time he was about to get it over the crest its weight turned it back, and it rolled down to the plain again, and he started over with the sweat running off him.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Punished | Among the dead | Dead | 2018-03-24, seen |

## Note

Not filed as a lesson. I have been told several times that it ought to be one, given the last ten years, and I decline. A stone that rolls back by design is a punishment. A voyage that rolls back is weather, crew and one god ([[knowledge/poseidon-at-sea]]), and each of those has its own record.

See [[people/minos]], [[people/tantalus]], and the account of the crossing at [[voyage/_index]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/minos.md", "people/tantalus.md", "voyage/_index.md", "voyage/legs/house-of-the-dead.md", "knowledge/poseidon-at-sea.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  {
    path: "people/tantalus.md",
    title: "Tantalus",
    type: "shade",
    created: "2018-03-24",
    updated: "2026-07-11",
    status: "closed",
    tags: ["shades", "acheron"],
    places: ["place:acheron"],
    summary: "Seen standing in a pool that drains whenever he bends to drink, under fruit the wind lifts away.",
    body: `Observed, not met.

## Relationship

None. At the Acheron ([[voyage/legs/house-of-the-dead]]) he stood in a pool up to his chin. Each time he stooped to drink, the water drained away and the earth showed dry at his feet. Fruit trees hung over his head, pears and figs and olives, and each time he reached for one the wind lifted it to the clouds.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Punished | Among the dead | Dead | 2018-03-24, seen |

## Note

Written down the same night with [[people/sisyphus]] and [[people/minos]], because the order of what I saw mattered to me then. It matters less now.

One practical line survived from this entry into the voyage file: water within reach is not water in the skin. The raft carries one skin of water, and the shortfall is a separate review on [[voyage/ogygia/raft]], worked in [[studies/water-ration]] and held in [[ogygia/stores/water]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/sisyphus.md", "people/minos.md", "voyage/ogygia/raft.md", "voyage/legs/house-of-the-dead.md", "studies/water-ration.md", "ogygia/stores/water.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "2018-03-24", day: 620 },
  },
  // ------------------------------------------------------------ the gods
  {
    path: "people/hermes.md",
    title: "Hermes",
    type: "deity",
    created: "2017-03-15",
    updated: "2026-07-07",
    status: "active",
    tags: ["gods", "messenger", "ogygia"],
    people: ["person:circe", "person:calypso", "person:athena"],
    places: ["place:aeaea", "place:ogygia"],
    summary: "Messenger. Gave the moly on Aeaea; brought the order for release to Ogygia on day 3647.",
    body: `## Relationship

Messenger of the gods. Two interventions in ten years, both decisive, both on someone else's instruction.

| Day | Where | What |
| --- | --- | --- |
| 248 | Aeaea ([[voyage/day-248-moly]]) | Met me on the path to [[people/circe]]'s house, gave me the [[knowledge/moly]] and told me exactly what to do when she struck with the wand. |
| 3647 | Ogygia ([[ogygia/build/day-3647-the-order]]) | Brought Zeus's order to [[people/calypso]]: let him go. I was on the shore and did not see him. She swore the same day: [[oaths/calypso-no-harm]]. |

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Messenger | Olympos | Ally on instruction | 2026-07-07, reported (by Calypso) |

He also carried word of the cattle to Calypso years ago, which is how I know what [[people/helios]] demanded. See that record.

## Outstanding

- [ ] Thanks for the moly, unpaid since day 248. No altar on Ogygia is mine to use.
- [ ] Do not mistake him for a patron. The patron is [[people/athena]]; he comes when [[people/zeus]] sends him.

Filed under [[people/_index]]. What he bears on: [[knowledge/hermes]].`,
    links: ["oaths/calypso-no-harm.md", "people/_index.md", "people/circe.md", "people/calypso.md", "people/helios.md", "people/athena.md", "people/zeus.md", "voyage/day-248-moly.md", "knowledge/moly.md", "ogygia/build/day-3647-the-order.md", "knowledge/hermes.md"],
    fields: { standing: "ally", confidence: "reported", last_news: "2026-07-07", day: 3647 },
  },
  {
    path: "people/zeus.md",
    title: "Zeus",
    type: "deity",
    created: "2019-07-01",
    updated: "2026-07-07",
    status: "active",
    tags: ["gods", "council", "thrinacia"],
    people: ["person:athena", "person:poseidon", "person:calypso"],
    places: ["place:thrinacia", "place:ogygia"],
    summary: "Broke the ship at Helios's demand on day 1084; ordered the release on day 3647.",
    body: `## Relationship

Holds the council. Every decision about this voyage that was not made by the sea or the crew was made by him.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Head of the council | Olympos | Has ruled for release | 2026-07-07, reported |

## The record

- **Day 1084.** Off Thrinacia, the storm out of a clear sky; the bolt that split the ship ([[voyage/day-1084-the-storm]], [[omens/day-1084-thunder]]). Thirty-one men. He did it because [[people/helios]] asked, and because the crew had eaten the cattle. See [[decisions/cattle-of-helios]].
- **Day 3647.** [[people/hermes]] arrived with his order ([[ogygia/build/day-3647-the-order]]) to [[people/calypso]]. It followed [[people/athena]] arguing the case in council while [[people/poseidon]] was away. Calypso swore her oath the same day: [[oaths/calypso-no-harm]].

I hold no grievance against him for the first; it was the condition of the forecast and it was broken. I owe him for the second.

## Outstanding

- [ ] An offering when there is a beast to offer and a hearth to offer it on. Not before Ithaca.
- [ ] Watch the weather on the crossing. His storm did not need a cloud.

Filed under [[people/_index]]. As a sailor reckons him: [[knowledge/zeus]].`,
    links: ["oaths/calypso-no-harm.md", "people/_index.md", "people/helios.md", "decisions/cattle-of-helios.md", "people/hermes.md", "people/calypso.md", "people/athena.md", "people/poseidon.md", "voyage/day-1084-the-storm.md", "omens/day-1084-thunder.md", "ogygia/build/day-3647-the-order.md", "knowledge/zeus.md"],
    fields: { standing: "council", confidence: "reported", last_news: "2026-07-07", day: 3647 },
  },
  {
    path: "people/helios.md",
    title: "Helios",
    type: "deity",
    created: "2019-07-20",
    updated: "2019-07-20",
    status: "closed",
    tags: ["gods", "thrinacia", "oath"],
    people: ["person:calypso", "person:teiresias", "person:circe"],
    places: ["place:thrinacia"],
    summary: "Owner of the herds on Thrinacia. Demanded the crew's deaths and was given them.",
    body: `## Relationship

The sun. Owner ([[knowledge/thrinacia-cattle]]) of the seven herds of cattle and seven flocks of sheep on Thrinacia, fifty head each, which neither breed nor die. Two warnings came in advance: [[people/teiresias]] and [[people/circe]]. Both said the same thing.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Owner of the herds | Overhead | Satisfied; account closed | 2019-07-20, reported (by Calypso) |

## What he demanded

I know this only at third hand. [[people/calypso]] told me, soon after I washed up, that she had it from [[people/hermes]]: Helios went to the council and said that unless the men who killed his cattle paid for it, he would go down and shine among the dead instead. Zeus answered with the storm ([[voyage/day-1084-the-storm]]).

## Outstanding

Nothing. The oath was sworn by every man and broken by every man but one ([[oaths/helios]]; the names are in [[crew/oath-signatories]]). The one who kept it is alive. Nobody else is.

The daughter who carried him the news: [[people/lampetie]].

Filed under [[people/_index]]. As a sailor reckons him: [[knowledge/helios]].`,
    links: ["people/_index.md", "people/teiresias.md", "people/circe.md", "people/calypso.md", "people/hermes.md", "oaths/helios.md", "people/lampetie.md", "knowledge/thrinacia-cattle.md", "voyage/day-1084-the-storm.md", "crew/oath-signatories.md", "knowledge/helios.md"],
    fields: { standing: "closed", confidence: "reported", last_news: "2019-07-20", day: 1095 },
  },
  {
    path: "people/lampetie.md",
    title: "Lampetie",
    type: "deity",
    created: "2019-05-22",
    updated: "2019-07-20",
    status: "closed",
    tags: ["gods", "thrinacia"],
    people: ["person:circe", "person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Daughter of Helios, keeper of the herds on Thrinacia with her sister. Carried him word of the killing.",
    body: `## Relationship

Daughter of [[people/helios]], herding his cattle on Thrinacia with her sister Phaethusa. Never seen. [[people/circe]] named the two of them in the route briefing on day 1038 ([[voyage/day-1038-circes-route]]), so I knew whose land it was before the keel touched.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Keeper of the herds | Thrinacia | Unseen; did her duty | 2019-07-20, reported |

## The record

On day 1077 ([[voyage/day-1077-the-cattle]]) the crew, led by [[crew/eurylochus]], drove off the best of the cattle while I was asleep up the island. Lampetie went straight to her father with the news. That is how quickly it reached the council: no later than the smoke from the spits.

I learned her part only on Ogygia, through [[people/calypso]].

## Note

No grievance; she was keeping her father's herds. If I had kept the crew as well as she kept the cattle there would be no entry for her at all.

Filed under [[people/_index]]. See [[decisions/cattle-of-helios]] and [[knowledge/thrinacia-cattle]].`,
    links: ["people/_index.md", "people/helios.md", "people/circe.md", "crew/eurylochus.md", "people/calypso.md", "decisions/cattle-of-helios.md", "voyage/day-1038-circes-route.md", "voyage/day-1077-the-cattle.md", "knowledge/thrinacia-cattle.md"],
    fields: { standing: "neutral", confidence: "reported", last_news: "2019-07-20", day: 1077 },
  },
  {
    path: "people/proteus.md",
    title: "Proteus",
    type: "deity",
    created: "2026-07-09",
    updated: "2026-07-09",
    status: "active",
    tags: ["gods", "sparta", "news"],
    people: ["person:menelaus", "person:telemachus", "person:calypso"],
    places: ["place:sparta", "place:ogygia"],
    summary: "Old man of the sea. Told Menelaus, under compulsion, that I was held on an island. Reported only.",
    body: `Never met. Every line here is reported.

## Relationship

The old man of the sea, who serves Poseidon and knows every depth. [[people/menelaus]], becalmed at Pharos off the Egyptian coast on his own way home, lay among the seals and held him through every shape he took until he answered.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Sea-god | Pharos | Source, compelled | 2026-07-09, reported (Sparta, via Telemachus) |

## What he said, as Menelaus gave it to [[people/telemachus]]

- [[people/ajax-son-of-oileus]] drowned on the way home, at the rocks.
- [[people/agamemnon]] was murdered on arriving.
- A third man, alive, held on an island by the nymph [[people/calypso]], with no ship and no crew to row him.

## Note

The third item is the first time anyone outside this island has had my position right in seven years. Menelaus has known it for some while; the report reached me as [[ithaca/news/day-3649-sparta]]. See also [[ithaca/telemachus/what-he-heard]]. It is accurate as of the day he heard it, and will stop being accurate today.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/menelaus.md", "people/telemachus.md", "people/ajax-son-of-oileus.md", "people/agamemnon.md", "people/calypso.md", "ithaca/news/day-3649-sparta.md", "ithaca/telemachus/what-he-heard.md"],
    fields: { standing: "source", confidence: "reported", last_news: "2026-07-09" },
  },
  {
    path: "people/thoosa.md",
    title: "Thoosa",
    type: "deity",
    created: "2019-08-02",
    updated: "2019-08-02",
    status: "closed",
    tags: ["gods", "cyclopes", "grievance"],
    people: ["person:polyphemus", "person:poseidon", "person:calypso"],
    places: ["place:cyclopes"],
    summary: "Sea-nymph, mother of Polyphemus by Poseidon. Known only as a name and a lineage.",
    body: `Known by name only.

## Relationship

None directly. A sea-nymph, daughter of Phorcys, and the mother of [[people/polyphemus]] by [[people/poseidon]]. [[people/calypso]] gave me the lineage in the first year here, when I asked why a single blinded shepherd should have a god's whole attention.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Mother of Polyphemus | The sea | Unknown | 2019-08-02, reported |

## Note

Filed because it changed how I read the grievance. I had thought of it as a god taking up a dependant's complaint. It is a father's complaint about what was done to his son, and the son's mother is a nymph of the sea he rules. That is not a dispute that lapses with time; it is a family's.

No action. There is nothing she can be asked and nothing she has done.

See [[decisions/name-at-the-stern]], [[oaths/polyphemus-curse]], [[knowledge/poseidon-at-sea]] and [[people/_index]].`,
    links: ["people/_index.md", "people/polyphemus.md", "people/poseidon.md", "people/calypso.md", "decisions/name-at-the-stern.md", "oaths/polyphemus-curse.md", "knowledge/poseidon-at-sea.md"],
    fields: { standing: "unknown", confidence: "reported", last_news: "2019-08-02" },
  },
  // ------------------------------------------------------------ the hosts and the hostile of the voyage
  {
    path: "people/maron.md",
    title: "Maron",
    type: "person",
    created: "2016-07-21",
    updated: "2016-10-19",
    status: "dormant",
    tags: ["voyage", "ismarus", "debt"],
    people: ["person:polyphemus"],
    places: ["place:ismarus", "place:cyclopes"],
    summary: "Priest of Apollo at Ismarus. Spared in the raid; gave the wine that put Polyphemus under.",
    body: `## Relationship

Son of Euanthes, priest of Apollo, living in the god's grove at Ismarus. On day 9, in the raid on the Cicones, we spared him ([[decisions/spare-maron]]) with his wife and child out of respect for the god. He gave in return seven talents of worked gold, a mixing bowl of solid silver, and twelve jars of sweet unmixed wine, so strong it is cut twenty measures of water to one. He had kept it secret from all his household but his wife and one housekeeper.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Priest of Apollo | Ismarus, Thrace | Living when last seen | 2016-07-21, seen |

## Outstanding

The wine ([[crew/ismarus-wine-ration]]) saved the rest of ship 1 in [[people/polyphemus]]'s cave on day 99. It is the single best gift of the voyage, and it came from the one man we did not rob.

- [ ] An offering to Apollo at Ithaca, in Maron's name.
- [ ] Note for the record: the same day cost seventy-two men who would not leave the beach and the wine. See [[crew/losses/ismarus]] and [[crew/_index]].

Filed under [[people/_index]]. The pledge: [[oaths/maron-guest-gift]].`,
    links: ["people/_index.md", "people/polyphemus.md", "crew/_index.md", "decisions/spare-maron.md", "crew/ismarus-wine-ration.md", "crew/losses/ismarus.md", "oaths/maron-guest-gift.md"],
    fields: { standing: "benefactor", confidence: "seen", last_news: "2016-07-21", day: 9 },
  },
  {
    path: "people/aeolus.md",
    title: "Aeolus",
    type: "person",
    created: "2016-11-21",
    updated: "2016-12-31",
    status: "closed",
    tags: ["voyage", "aeolia", "winds"],
    places: ["place:aeolia", "place:ithaca"],
    summary: "Keeper of the winds. A month's host; gave the bag; refused us a second time.",
    body: `## Relationship

Son of Hippotes, keeper of the winds, on a floating island walled in bronze. Six sons married to his six daughters, feasting all year round. A month as his guest from day 132; he wanted the whole of Troy from me, story by story.

At parting he gave me the adverse winds bound in an oxhide bag, tied shut with a bright wire, and set the west wind to carry us home.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| King, keeper of the winds | Aeolia | Refuses contact | 2016-12-31, seen |

## The record

- **Day 171.** Ithaca in sight; men tending fires on the shore. I slept, after nine days at the sheet ([[decisions/keep-the-helm-nine-days]]). The crew opened the bag thinking it held treasure.
- **Day 172.** Blown back to his island ([[voyage/day-172-aeolus-refuses]]). He would not hear me out: a man so hated by the gods was not to be helped or sent on. We left by oar.

## Outstanding

Nothing to be done. The account is closed from his side. From mine, one line: do not sleep within sight of home.

Filed under [[people/_index]]. See [[voyage/_index]], [[oaths/xenia-aeolus]] and [[knowledge/aeolus]].`,
    links: ["people/_index.md", "voyage/_index.md", "decisions/keep-the-helm-nine-days.md", "voyage/day-172-aeolus-refuses.md", "oaths/xenia-aeolus.md", "knowledge/aeolus.md"],
    fields: { standing: "closed", confidence: "seen", last_news: "2016-12-31", day: 172 },
  },
  {
    path: "people/antiphates.md",
    title: "Antiphates",
    type: "person",
    created: "2017-02-02",
    updated: "2017-02-02",
    status: "closed",
    tags: ["voyage", "laestrygonians", "hostile"],
    places: ["place:laestrygonians"],
    summary: "King of the Laestrygonians. Eleven ships destroyed in his harbour on day 205.",
    body: `## Relationship

King of the Laestrygonians at Telepylus. Hostile from the first sight of him.

Three scouts went up to the town on day 205 ([[voyage/day-205-laestrygonian-harbour]]). They met his daughter drawing water at the spring, who sent them to her father's house; they met his wife there, the size of a mountain peak, who called him from the assembly. He seized one of the scouts on the spot to eat; that man came from one of the eleven ships and is counted in the 484. The other two ran for the ships.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| King | Land of the Laestrygonians | Hostile | 2017-02-02, seen |

## The record

He raised the town. They came down to the cliffs above the harbour in thousands and stoned the ships, and speared the men like fish. Eleven ships destroyed, four hundred and eighty-four men. Ship 1 lay outside the harbour mouth, moored to a rock; I cut the cable with my sword and we rowed ([[decisions/cut-the-cable]]).

## Outstanding

Nothing to be settled with him. The losses are carried in [[crew/losses/laestrygonians]] and [[crew/_index]], ship by ship. The harbour decision is mine and stays open: I moored outside ([[decisions/moor-outside-the-harbour]]). I did not order the others to.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "crew/_index.md", "voyage/day-205-laestrygonian-harbour.md", "decisions/cut-the-cable.md", "crew/losses/laestrygonians.md", "decisions/moor-outside-the-harbour.md"],
    fields: { standing: "hostile", confidence: "seen", last_news: "2017-02-02", day: 205, cost: "11 ships, 484 men" },
  },
  // ------------------------------------------------------------ the household
  {
    path: "people/eurycleia.md",
    title: "Eurycleia",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-08",
    status: "active",
    tags: ["household", "ithaca"],
    people: ["person:penelope", "person:telemachus", "person:laertes"],
    places: ["place:ithaca"],
    summary: "Nurse to me and to Telemachus. Provisioned his ship in secret and kept it from Penelope.",
    body: `## Relationship

Daughter of Ops. [[people/laertes]] bought her when she was young for the price of twenty oxen, and honoured her in the house like his wife. She nursed me, and then nursed [[people/telemachus]]. She knows the scar on my leg better than I do; she washed it when it was new. See [[people/autolycus]] and [[knowledge/wounds]].

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Nurse, keeper of the stores | The house, Ithaca | Loyal | 2026-07-08, reported |

## Latest

Reported with the news from the hall: she drew the wine and barley for Telemachus's voyage from the storeroom ([[ithaca/stores/storeroom]]) herself, and he made her swear not to tell [[people/penelope]] until the twelfth day or until she missed him. When Penelope learned, Eurycleia told her everything and sent her up to pray rather than to weep.

## Outstanding

- [ ] She will know me before anyone else does, by the scar, whatever I look like. Plan for that rather than against it.
- [ ] She is old. Do not put a task on her that the household can do.

Filed under [[people/_index]] and [[ithaca/_index]]. Household record: [[ithaca/household/eurycleia]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/laertes.md", "people/telemachus.md", "people/autolycus.md", "people/penelope.md", "knowledge/wounds.md", "ithaca/stores/storeroom.md", "ithaca/household/eurycleia.md"],
    fields: { standing: "household", confidence: "reported", last_news: "2026-07-08" },
  },
  {
    path: "people/mentor.md",
    title: "Mentor",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["household", "ithaca", "steward"],
    people: ["person:telemachus", "person:penelope"],
    places: ["place:ithaca"],
    summary: "Old friend. Given charge of the household at the sailing. Spoke against the suitors in the assembly.",
    body: `## Relationship

Son of Alcimus, friend from boyhood. When the ships left I put the whole household in his charge: to defer to the old man and keep everything safe. That instruction has had to cover twenty years.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Keeper of the household | Ithaca | Loyal | 2026-07-04, reported |
| Phone | 555-0121 | | |
| Email | mentor@example.com | | |

## Latest

Reported from the assembly [[people/telemachus]] called before sailing ([[ithaca/telemachus/assembly]], [[ithaca/news/day-3644-assembly]]): Mentor stood up after [[people/halitherses]] and told the people of Ithaca it was not the suitors he blamed most but the rest of them, sitting silent, many against few, and saying nothing. [[people/leiocritus]] answered him with a threat and dismissed the assembly.

## Outstanding

- [ ] He was given a household and handed back a hall full of strangers. None of that is his failure; say so first.
- [ ] Ask him for the names of those who sat silent. Not for a list of enemies. For a list of who can be talked to.

Filed under [[people/_index]] and [[ithaca/_index]]. Household record: [[ithaca/household/mentor]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/telemachus.md", "people/halitherses.md", "people/leiocritus.md", "ithaca/telemachus/assembly.md", "ithaca/news/day-3644-assembly.md", "ithaca/household/mentor.md"],
    fields: { standing: "household", confidence: "reported", last_news: "2026-07-04" },
  },
  {
    path: "people/medon.md",
    title: "Medon",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-08",
    status: "active",
    tags: ["household", "ithaca", "suitors"],
    people: ["person:penelope", "person:antinous", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Herald of the house. Serves the suitors' table; overheard the ambush plan and told Penelope.",
    body: `## Relationship

Herald of the household. Since the suitors came he has served at their feasts, because a herald serves whoever sits in the hall. He listens while he does it.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Herald | The hall, Ithaca | Loyal, in a hostile room | 2026-07-08, reported |
| Phone | 555-0143 | | |

## Latest

Reported 2026-07-08 ([[ithaca/news/day-3648-medon]]): standing outside the courtyard on day 3646, he heard [[people/antinous]] and the others plan to take a ship and twenty men to the strait between Ithaca and Same and wait there for [[people/telemachus]]. He went straight to [[people/penelope]] with it.

That confirms the ambush entry ([[ithaca/suitors/ambush-ship]]) on Telemachus's record, first reported on 2026-07-06. One witness, overheard, not seen. It is good enough to act on and not good enough to quote as certain.

## Outstanding

- [ ] He has served both tables. When the hall is cleared, his case is to be heard before anyone judges it. He brought the warning.
- [ ] Confirm the size and station of the ambush ship if he hears more.

Filed under [[people/_index]] and [[ithaca/_index]]. Household record: [[ithaca/household/medon]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/antinous.md", "people/telemachus.md", "people/penelope.md", "ithaca/news/day-3648-medon.md", "ithaca/suitors/ambush-ship.md", "ithaca/household/medon.md"],
    fields: { standing: "household", confidence: "reported", last_news: "2026-07-08" },
  },
  {
    path: "people/phemius.md",
    title: "Phemius",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["household", "ithaca", "bard"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "The house's bard, son of Terpes. Sings for the suitors because they make him.",
    body: `## Relationship

Son of Terpes, the household's bard. He sang in the hall before the war. He sings in it now, for the suitors, because they compel him to; that point is in the reports more than once and I record it as given.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Bard | The hall, Ithaca | Compelled | 2026-07-04, reported |

## Latest

Reported, early this summer: he sang of the bitter homecoming of the Achaeans from Troy. [[people/penelope]] came down from her room in tears and asked him to sing anything else. [[people/telemachus]] told her to let him sing what the hall wanted; the bard was not to blame for the story, and the homecoming had not been unkind to me alone.

## Note

So the song of our return is already being sung in my own hall, without its last verse. I had not expected that to land as hard as it did.

## Outstanding

- [ ] He sang under compulsion. That is to be his defence and I expect to accept it.

Filed under [[people/_index]] and [[ithaca/_index]]. See [[ithaca/household/phemius]] and [[ithaca/suitors/retinue]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/penelope.md", "people/telemachus.md", "ithaca/household/phemius.md", "ithaca/suitors/retinue.md"],
    fields: { standing: "household", confidence: "reported", last_news: "2026-07-04" },
  },
  {
    path: "people/halitherses.md",
    title: "Halitherses",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["ithaca", "seer", "forecast"],
    people: ["person:telemachus", "person:teiresias"],
    places: ["place:ithaca"],
    summary: "Ithaca's bird-reader. At the sailing he forecast the twentieth year, alone, unrecognised. So far, correct.",
    body: `## Relationship

Son of Mastor, the island's best reader of birds. Old already when we sailed.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Seer | Ithaca | Friendly | 2026-07-04, reported |

## His forecast at the sailing

Given on the quay, twenty years ago, and nobody took it well: I would lose all my companions, and come home in the twentieth year, unknown to everyone.

| Condition | Standing today |
| --- | --- |
| All companions lost | Met. See [[crew/_index]]. |
| Twentieth year | Due. |
| Unknown to everyone | Open. |

It agrees with [[knowledge/teiresias-forecast]], which was given ten years later by someone who had never heard it. Clause by clause: [[studies/forecast-after-the-crossing]].

## Latest

Reported from [[people/telemachus]]'s assembly ([[ithaca/telemachus/assembly]]): two eagles ([[omens/day-3644-two-eagles]]) sent down from the mountain flew level on the wind, then wheeled over the meeting, struck at each other's heads and necks with their talons, and went off east over the town. He read it aloud: I am near, and planning death for the suitors. [[people/eurymachus]] told him to go home and read omens for his children.

## Outstanding

- [ ] When the forecast closes, tell him first. He has waited for it longer than anyone.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "crew/_index.md", "knowledge/teiresias-forecast.md", "people/telemachus.md", "people/eurymachus.md", "studies/forecast-after-the-crossing.md", "ithaca/telemachus/assembly.md", "omens/day-3644-two-eagles.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-04" },
  },
  {
    path: "people/aegyptius.md",
    title: "Aegyptius",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-04",
    status: "active",
    tags: ["ithaca", "elders", "owed"],
    people: ["person:polyphemus", "person:telemachus"],
    places: ["place:ithaca", "place:cyclopes"],
    summary: "Elder of Ithaca. His son Antiphus sailed with me and was the last man Polyphemus ate. He does not know.",
    body: `## Relationship

An elder, bent with age. He opened the assembly ([[ithaca/telemachus/assembly]]) that [[people/telemachus]] called this summer: the first since my ships sailed. He has four sons. [[crew/antiphus]] sailed with me on ship 1. Eurynomus is among the suitors. Two keep their father's farm.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Elder | Ithaca | Friendly; grieving without knowing for what | 2026-07-04, reported |

## What he does not know

Antiphus was the last of the six that [[people/polyphemus]] killed in the cave, on the evening before we escaped, day 98 ([[voyage/day-98-the-stake]]). Aegyptius has never been told. He still mourns him as missing, and he wept for him in the assembly before he spoke.

## Outstanding

This is the hardest debt in the household file.

- [ ] Tell him in person, privately, before anything is said about the hall. Not by message.
- [ ] Tell him the cave and the count honestly. Do not make it braver than it was.
- [ ] Eurynomus is in the hall. Settle what is owed the father before anything is settled with the son.

Filed under [[people/_index]]. The count: [[crew/losses/cyclopes]] and [[crew/_index]].`,
    links: ["people/_index.md", "people/telemachus.md", "people/polyphemus.md", "crew/_index.md", "ithaca/telemachus/assembly.md", "crew/antiphus.md", "voyage/day-98-the-stake.md", "crew/losses/cyclopes.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-04", owed: "news of Antiphus" },
  },
  {
    path: "people/dolius.md",
    title: "Dolius",
    type: "person",
    created: "2019-03-02",
    updated: "2025-05-07",
    status: "active",
    tags: ["household", "ithaca", "farm"],
    people: ["person:laertes", "person:penelope"],
    places: ["place:ithaca"],
    summary: "Laertes's old servant on the upland farm, with his sons. Father of Melanthius and Melantho.",
    body: `## Relationship

An old servant given to [[people/penelope]] by her father when she came to Ithaca, now keeping the orchards and vines ([[ithaca/island/orchard]]) on the upland farm ([[ithaca/island/laertes-farm]]) with his sons. His wife looks after [[people/laertes]].

His other two children are in the town and on the other side: [[people/melanthius]] keeps the goats and drives the best of them to the hall, and [[people/melantho]] is with the suitors. That is a lot for one family to hold, and I have no report that he holds it badly.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Farm servant | The upland farm, Ithaca | Loyal | 2025-05-07, reported |
| Phone | through the farm line (see Laertes) | | |

## Outstanding

- [ ] When the news about the farm ([[ithaca/news/day-3221-laertes]]) is next refreshed, ask about Dolius by name, not only about my father.
- [ ] Keep his record separate from his children's. The farm should not answer for the town.

Filed under [[people/_index]] and [[ithaca/_index]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/penelope.md", "people/laertes.md", "people/melanthius.md", "people/melantho.md", "ithaca/island/orchard.md", "ithaca/island/laertes-farm.md", "ithaca/news/day-3221-laertes.md"],
    fields: { standing: "household", confidence: "reported", last_news: "2025-05-07" },
  },
  {
    path: "people/ctimene.md",
    title: "Ctimene",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "dormant",
    tags: ["household", "family"],
    people: ["person:eumaeus", "person:laertes"],
    places: ["place:ithaca"],
    summary: "Younger sister. Married on Same before the war. No news in twenty years.",
    body: `## Relationship

My younger sister, the last of my mother's children. She grew up alongside [[people/eumaeus]], who was brought up in the house almost as one of us. Married on Same before the war, for a large bride-price, and went over the strait to her husband's house.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Sister | Same | Unknown | before the sailing, seen |
| Phone | 555-0156 (last known; unconfirmed) | | |

## Note

No report about her has reached me in twenty years. I do not know if she has children, or if she knows our mother is dead. See [[people/anticleia]] and [[ithaca/household/anticleia]].

The suitors' ambush ship ([[ithaca/suitors/ambush-ship]]) waits in the strait between Ithaca and Same. Her husband's people will have seen it from their side. That is not a reason to call on them; it is a reason to know whose shore it is.

## Outstanding

- [ ] Tell her about our mother, if no one else has.
- [ ] Find out whether any of the Same men in the hall ([[ithaca/suitors/same]]) are her husband's kin, before anything is decided about them. See [[people/ctesippus]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/eumaeus.md", "people/anticleia.md", "people/ctesippus.md", "ithaca/household/anticleia.md", "ithaca/suitors/ambush-ship.md", "ithaca/suitors/same.md"],
    fields: { standing: "family", confidence: "seen", last_news: "before the sailing" },
  },
  {
    path: "people/philoetius.md",
    title: "Philoetius",
    type: "person",
    created: "2019-03-02",
    updated: "2026-06-04",
    status: "active",
    tags: ["household", "herds", "ithaca"],
    people: ["person:eumaeus"],
    places: ["place:ithaca"],
    summary: "Cowherd, set over the cattle on the mainland when he was a boy. Loyalty last confirmed at the sailing.",
    body: `## Relationship

I set him over the cattle in the country of the Cephallenians, across the water, when he was still a boy. The herd under him had grown beyond counting before the war. The cattle line in the estate ledger is his work.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Cowherd | The mainland pastures | Last known loyal | 2026-06-04, reported |

## Latest

What reaches me is the ledger, not the man: [[ithaca/estate]] carries cattle at 96 consumed of 720 held ([[ithaca/stores/cattle]]). Somebody is ferrying the beasts across to the hall, and the only person who can be doing it is the man who keeps them. I have no report of what he thinks of it.

## Note

I am not drawing a conclusion. [[people/eumaeus]] sends pigs to the same table every day, and his loyalty is not in question; a herdsman who refuses the hall loses the herd. The ledger shows what was taken, not who wanted it taken.

## Outstanding

- [ ] Find out where he stands, quietly, through Eumaeus, before he is told anything.

Filed under [[people/_index]]. See [[ithaca/island/philoetius-cattle]] and [[ithaca/news/day-3614-eumaeus]].`,
    links: ["people/_index.md", "ithaca/estate.md", "people/eumaeus.md", "ithaca/stores/cattle.md", "ithaca/island/philoetius-cattle.md", "ithaca/news/day-3614-eumaeus.md"],
    fields: { standing: "unknown", confidence: "reported", last_news: "2026-06-04" },
  },
  {
    path: "people/melanthius.md",
    title: "Melanthius",
    type: "person",
    created: "2019-03-02",
    updated: "2026-06-04",
    status: "active",
    tags: ["ithaca", "herds", "suitors"],
    people: ["person:eumaeus", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Goatherd, son of Dolius. Drives the best of the goats to the hall and keeps the suitors' company.",
    body: `## Relationship

Son of [[people/dolius]]. Keeper of the goat herds. Before the war, an ordinary hand on the estate.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Goatherd | Ithaca | Sides with the suitors | 2026-06-04, reported |

## Latest

Reported through the estate news ([[ithaca/news/day-3614-eumaeus]]): he brings the choicest goats in to the hall for the suitors' dinners and sits at their tables when he has done it. The goat line in [[ithaca/estate]] stands at 410 consumed of 1,200 held ([[ithaca/stores/goats]]).

The contrast with [[people/eumaeus]] is in the same ledger. Both drive animals to the same hall. One does it under protest and keeps the breeding stock back; the other does it to be thought well of by [[people/antinous]].

## Outstanding

- [ ] The report comes from people who dislike him. Mark it as such; confirm it before acting on it.
- [ ] Whatever is decided about him is decided separately from his father. See [[people/dolius]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/dolius.md", "ithaca/estate.md", "people/eumaeus.md", "people/antinous.md", "ithaca/news/day-3614-eumaeus.md", "ithaca/stores/goats.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-06-04" },
  },
  {
    path: "people/melantho.md",
    title: "Melantho",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "active",
    tags: ["ithaca", "household", "suitors"],
    people: ["person:penelope"],
    places: ["place:ithaca"],
    summary: "One of Penelope's maids, daughter of Dolius, raised by Penelope. Reported to be with Eurymachus.",
    body: `## Relationship

Daughter of [[people/dolius]], sister of [[people/melanthius]]. [[people/penelope]] brought her up like her own child and gave her toys and clothes as a girl. She serves in the house.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Maid | The house, Ithaca | Sides with the suitors | 2026-07-06, reported |

## Latest

Reported, not confirmed: she has no feeling for Penelope's grief and keeps company with [[people/eurymachus]]. Separately reported that some of the maids carried word of the loom to the suitors in its fourth year ([[ithaca/loom/discovery]], [[journal/day-3400]]). No name is attached to that report, and I am not attaching one.

## Outstanding

- [ ] Find out from [[people/eurycleia]], who knows every woman in the house, which of the maids have kept faith and which have not ([[ithaca/household/the-twelve]]). Do not rely on rumour from the hall.
- [ ] Record her honestly when the answer comes, either way.

Filed under [[people/_index]] and [[ithaca/_index]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/dolius.md", "people/melanthius.md", "people/penelope.md", "people/eurymachus.md", "people/eurycleia.md", "ithaca/loom/discovery.md", "journal/day-3400.md", "ithaca/household/the-twelve.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/noemon.md",
    title: "Noemon",
    type: "person",
    created: "2026-07-06",
    updated: "2026-07-06",
    status: "active",
    tags: ["ithaca", "ships", "telemachus"],
    people: ["person:telemachus", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Lent Telemachus his ship. Asked Antinous when it would be back, and so told the hall where it had gone.",
    body: `## Relationship

Son of Phronius, of Ithaca. Not known to me before the war beyond his father's name. He lent [[people/telemachus]] the ship for Pylos ([[ithaca/telemachus/ship-and-crew]]).

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Shipowner | Ithaca | Friendly; careless | 2026-07-06, reported |

## Latest

Reported 2026-07-06 ([[ithaca/news/day-3646-ambush]]): he came to [[people/antinous]] in the hall to ask when Telemachus would be back from sandy Pylos, because he needed the ship to cross to Elis for a mare and a mule colt. Until then the suitors thought Telemachus was on the island, out with the flocks or with the swineherd.

The ambush followed from that question. See [[people/medon]].

## Note

Not hostile. He asked an honest question in the wrong room. The ship he lent is the one that has to run the strait home. See [[ithaca/telemachus/return-risk]].

## Outstanding

- [ ] When this is over, the ship is to be returned to him in good order with something for its hire. He lent it when no one else did.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/telemachus.md", "people/antinous.md", "people/medon.md", "ithaca/telemachus/ship-and-crew.md", "ithaca/news/day-3646-ambush.md", "ithaca/telemachus/return-risk.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/icarius.md",
    title: "Icarius",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-04",
    status: "dormant",
    tags: ["family", "suitors"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Penelope's father. Reported on day 3640 to be urging her, with her brothers, to marry; the suitors want her sent back to his house for it.",
    body: `## Relationship

Father of [[people/penelope]]. I won her from his house. I have not seen him since the wedding feast.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Father-in-law | His own house | Urging her to marry | 2026-07-04, reported |

## Why he is in the reports

His name is being used ([[ithaca/suitors/their-case]]). In the assembly ([[ithaca/telemachus/assembly]]) [[people/eurymachus]] and the others demanded that Penelope go back to her father, so that he can choose her a husband and give her away with gifts. [[people/telemachus]] refused: to send his mother out of the house against her will would bring her curses on him, and he would owe Icarius a heavy repayment.

He has spoken for himself as well. The report of day 3640 ([[ithaca/news/day-3640-shroud-finished]]) says that he and her brothers are urging her to marry, now that the shroud is finished. That is a father's pressure, not a demand that she leave the house, and it is reported, not heard.

## Outstanding

- [ ] Do not count him with the suitors. He wants her married; they want her married to one of them.
- [ ] A message to him, after Ithaca, that his daughter kept the house for twenty years.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/penelope.md", "people/eurymachus.md", "people/telemachus.md", "ithaca/suitors/their-case.md", "ithaca/telemachus/assembly.md", "ithaca/news/day-3640-shroud-finished.md"],
    fields: { standing: "family", confidence: "reported", last_news: "2026-07-04" },
  },
  {
    path: "people/autolycus.md",
    title: "Autolycus",
    type: "person",
    created: "2019-03-02",
    updated: "2019-03-02",
    status: "dormant",
    tags: ["family", "scar"],
    people: ["person:laertes"],
    places: ["place:ithaca"],
    summary: "Maternal grandfather. Gave me my name, and on Parnassus the boar hunt and the scar.",
    body: `## Relationship

My mother's father. He came to Ithaca when I was born and was asked to name me. He chose the name: he had been angry with many men and women in his time, so let the boy be called after that.

When I was grown I went to his house on Parnassus to claim the gifts he had promised. His sons took me hunting; a boar came out of the thicket and opened my leg above the knee before I killed it. They bound it, sang over it to stop the blood ([[knowledge/wounds]]), and sent me home with the gifts.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Grandfather | Parnassus | Unknown | before the sailing, seen |

## Note

The scar is the one mark on me that cannot be disguised, and the one that [[people/eurycleia]] will know. It is also the only thing I carry from him except the name.

His daughter, my mother, is dead. See [[people/anticleia]] and [[ithaca/household/anticleia]]. I do not know whether he outlived her.

## Outstanding

- [ ] Ask [[people/laertes]] whether he lives.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/eurycleia.md", "people/anticleia.md", "people/laertes.md", "knowledge/wounds.md", "ithaca/household/anticleia.md"],
    fields: { standing: "family", confidence: "seen", last_news: "before the sailing" },
  },
  {
    path: "people/eupeithes.md",
    title: "Eupeithes",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "active",
    tags: ["ithaca", "suitors", "debt"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "Father of Antinous. I once kept the people of Ithaca from killing him. His son is in my hall.",
    body: `## Relationship

Father of [[people/antinous]]. Before the war he joined Taphian pirates raiding the Thesprotians, who were our allies. The people of Ithaca wanted him dead and his property eaten up. He came to my house as a suppliant ([[knowledge/suppliants]]) and I held them off him.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Father of the chief suitor | Ithaca | Owes a debt; standing unknown | 2026-07-06, reported (by name) |

## The account

| Owed | By | To |
| --- | --- | --- |
| His life and his estate | Eupeithes | me |
| Four years of the hall's stores ([[ithaca/stores/drawdown]]) | his son | the house |

I record both lines because both are true. One does not cancel the other.

## Outstanding

- [ ] Nothing reported says what he thinks of his son's conduct. Find out before assuming.
- [ ] Whatever happens in the hall, he will be the one who asks for an accounting afterwards. See [[ithaca/suitors/families]]. Expect it.

Filed under [[people/_index]] and [[ithaca/_index]].`,
    links: ["people/_index.md", "ithaca/_index.md", "people/antinous.md", "knowledge/suppliants.md", "ithaca/stores/drawdown.md", "ithaca/suitors/families.md"],
    fields: { standing: "unknown", confidence: "reported", last_news: "2026-07-06" },
  },
  // ------------------------------------------------------------ the hall
  {
    path: "people/eurymachus.md",
    title: "Eurymachus",
    type: "person",
    created: "2023-01-12",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "ithaca", "hostile"],
    people: ["person:antinous", "person:penelope", "person:telemachus"],
    places: ["place:ithaca"],
    summary: "Son of Polybus. Second among the suitors. Smooth in speech, and the most likely choice of the island.",
    body: `## Relationship

Son of Polybus, of Ithaca ([[ithaca/suitors/ithacans]]). Second only to [[people/antinous]] among the hundred and eight, and the one most often named after him in every report from the hall.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Suitor | The hall, Ithaca | Hostile | 2026-07-06, reported |

## The record, as reported

- In the assembly ([[ithaca/telemachus/assembly]]) he told [[people/halitherses]] to go home and read omens ([[omens/day-3644-two-eagles]]) for his own children, and said I had died far away and he wished the seer had died with me.
- He demanded [[people/penelope]] be sent back to [[people/icarius]] to be married, and said the suitors would go on eating the house until she chose.
- Reported 2026-07-06, unconfirmed: [[people/melantho]] keeps company with him.

## Note

He is careful where Antinous is loud. That makes him the more dangerous of the two in a room where people are deciding which way to go, and the less dangerous in a fight.

## Outstanding

- [ ] Nothing to be offered or received. Record and watch.

Filed under [[people/_index]]. Estate cost: [[ithaca/estate]].`,
    links: ["people/_index.md", "people/antinous.md", "people/halitherses.md", "people/penelope.md", "people/icarius.md", "people/melantho.md", "ithaca/estate.md", "ithaca/suitors/ithacans.md", "ithaca/telemachus/assembly.md", "omens/day-3644-two-eagles.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/amphinomus.md",
    title: "Amphinomus",
    type: "person",
    created: "2023-01-12",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "dulichium"],
    people: ["person:antinous", "person:penelope"],
    places: ["place:ithaca"],
    summary: "Son of Nisus, from Dulichium. Leads the Dulichian suitors. Reported as the best-mannered of them.",
    body: `## Relationship

Son of Nisus, of Dulichium, rich in wheat and grassland. Leader of the suitors who came from there ([[ithaca/suitors/dulichium]]). Not known to me personally.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Suitor | The hall, Ithaca | Hostile by presence; not by report | 2026-07-06, reported |

## The record, as reported

The reports agree that [[people/penelope]] finds his conversation the least objectionable of the hundred and eight, because he has some sense. No report has him threatening anyone, and none has him in the plan for the strait ([[ithaca/suitors/ambush-ship]]).

## Note

He is still in the hall, eating the house, with the rest. A decent man at an indecent table is still at the table. I record both halves, because the second fact is the one that will decide what happens to him and the first is the one I would like to be true.

## Outstanding

- [ ] If there is ever a moment to warn one of them to go home to Dulichium while he can, it is this one. Note it; do not promise it.

Filed under [[people/_index]]. The chief suitor: [[people/antinous]].`,
    links: ["people/_index.md", "people/penelope.md", "people/antinous.md", "ithaca/suitors/dulichium.md", "ithaca/suitors/ambush-ship.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/ctesippus.md",
    title: "Ctesippus",
    type: "person",
    created: "2023-01-12",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "same"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "Suitor from Same, of great wealth. Name on the roll only; no conduct yet reported.",
    body: `Name only.

## Relationship

A suitor from Same, said to be immensely rich and to trust in his wealth. One of the Same contingent in the hall ([[ithaca/suitors/same]]).

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Suitor | The hall, Ithaca | Hostile by presence | 2026-07-06, reported |

## Note

He is in the file because he is on the roll of the hundred and eight ([[ithaca/suitors/roster]]), which [[people/medon]] could give in his sleep. Nothing else has been reported about him: no words in the assembly, no part in the strait plan ([[ithaca/suitors/ambush-ship]]).

That is not the same as nothing done. Every man on the roll has eaten from the stores in [[ithaca/estate]] for up to four years.

## Outstanding

- [ ] Find out whether he is kin to my sister's husband's house on Same. See [[people/ctimene]].
- [ ] Do not write anything more about him than has been reported.

Filed under [[people/_index]]. The chief suitor: [[people/antinous]].`,
    links: ["people/_index.md", "people/medon.md", "ithaca/estate.md", "people/ctimene.md", "people/antinous.md", "ithaca/suitors/same.md", "ithaca/suitors/roster.md", "ithaca/suitors/ambush-ship.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/leodes.md",
    title: "Leodes",
    type: "person",
    created: "2023-01-12",
    updated: "2026-07-06",
    status: "active",
    tags: ["suitors", "seer"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "Son of Oenops. The suitors' soothsayer. Sits by the mixing bowl and is said to dislike their conduct.",
    body: `## Relationship

Son of Oenops. He reads the sacrifices ([[knowledge/sacrifice-procedure]]) for the suitors and sits always at the far end of the hall beside the mixing bowl.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Suitor; their soothsayer | The hall, Ithaca | Hostile by presence | 2026-07-06, reported |

## The record, as reported

Reported that he alone of them dislikes their recklessness and is angry with the others for it. Nothing reported has him saying so aloud in the hall.

## Note

A soothsayer who reads every day's sacrifice for the suitors, and has not read the eagles at the assembly ([[omens/day-3644-two-eagles]]) as [[people/halitherses]] did, is either reading badly or not saying what he reads. I do not know which, and the file should not guess.

## Outstanding

- [ ] If the report of his disapproval is true, he has had four years to leave and has not.
- [ ] Keep this record to what is reported. Do not let the second line above harden into a verdict without a hearing.

Filed under [[people/_index]]. See [[people/antinous]].`,
    links: ["people/_index.md", "people/halitherses.md", "people/antinous.md", "knowledge/sacrifice-procedure.md", "omens/day-3644-two-eagles.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/leiocritus.md",
    title: "Leiocritus",
    type: "person",
    created: "2023-01-12",
    updated: "2026-07-04",
    status: "active",
    tags: ["suitors", "assembly", "hostile"],
    people: ["person:telemachus", "person:antinous"],
    places: ["place:ithaca"],
    summary: "Son of Euenor. Dismissed Telemachus's assembly, and said I would die in my own hall if I came back.",
    body: `## Relationship

Son of Euenor. One of the suitors; not known to me before the war.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Suitor | The hall, Ithaca | Hostile | 2026-07-04, reported |

## The record, as reported

At the end of [[people/telemachus]]'s assembly ([[ithaca/telemachus/assembly]]) he answered [[people/mentor]]. The substance, as given:

> Even if Odysseus himself came back and found us feasting in his hall, his wife would have no joy of it. He would die there, fighting many with few.

Then he broke up the assembly and sent the people home to their own work.

## Note

Of everything reported from the hall, this is the only plain statement of intent toward me rather than toward my son or my stores. It is useful for that reason. It tells me what the room believes about numbers. He is not wrong about the numbers.

## Outstanding

- [ ] The arithmetic he gave is the arithmetic to solve. One against a hundred and eight ([[ithaca/suitors/roster]]) is not a fight; it is a plan ([[ithaca/homecoming-checklist]]). See [[people/antinous]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/telemachus.md", "people/mentor.md", "people/antinous.md", "ithaca/telemachus/assembly.md", "ithaca/suitors/roster.md", "ithaca/homecoming-checklist.md"],
    fields: { standing: "hostile", confidence: "reported", last_news: "2026-07-04" },
  },
  {
    path: "people/irus.md",
    title: "Irus",
    type: "person",
    created: "2023-01-12",
    updated: "2026-07-06",
    status: "active",
    tags: ["ithaca", "hall"],
    people: ["person:antinous"],
    places: ["place:ithaca"],
    summary: "The town beggar, Arnaeus by name. Runs errands for the suitors and lives on the hall's scraps.",
    body: `## Relationship

His mother named him Arnaeus; the young men call him Irus because he runs messages for anyone who sends him. A public beggar of the town, large and soft and not strong. He has the doorway of the hall ([[ithaca/hall/plan]]) as his station.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Beggar; errand-runner | The hall doorway, Ithaca | Neither side | 2026-07-06, reported |

## Note

He eats from the suitors' table because they are the table. He is not one of them. The reports place him in the hall daily ([[ithaca/hall/daily-pattern]]), and he hears what is said there as well as [[people/medon]] does, without the loyalty.

One practical point. The doorway of the hall belongs to whoever holds it, and a newcomer at that door would have him to deal with first. A beggar is the one stranger in Ithaca nobody looks at twice.

## Outstanding

- [ ] Nothing owed either way.
- [ ] Note for the planning file ([[ithaca/homecoming-checklist]]): the beggar's place at the door is the one way into the hall that the suitors do not guard.

Filed under [[people/_index]]. The hall: [[people/antinous]].`,
    links: ["people/_index.md", "people/medon.md", "people/antinous.md", "ithaca/hall/plan.md", "ithaca/hall/daily-pattern.md", "ithaca/homecoming-checklist.md"],
    fields: { standing: "neutral", confidence: "reported", last_news: "2026-07-06" },
  },
  // ------------------------------------------------------------ the fleet and the kings
  {
    path: "people/helen.md",
    title: "Helen",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-09",
    status: "active",
    tags: ["sparta", "troy", "news"],
    people: ["person:menelaus", "person:telemachus"],
    places: ["place:sparta", "place:troy"],
    summary: "At home in Sparta again. At Troy she knew me in disguise and kept it to herself. Received Telemachus.",
    body: `## Relationship

Wife of [[people/menelaus]]. The cause of the war, by the usual account (see [[oaths/tyndareus-oath]]); I keep no opinion on that in this file.

At Troy, in the last year, I went into the city disfigured, in rags, as a beggar. She alone knew me. She bathed me, anointed me and swore a great oath not to tell the Trojans until I was back at the ships. She kept it. I killed a number of Trojans on the way out and took back a good deal of what I learned.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Queen | Sparta | Friendly | 2026-07-09, reported (via Telemachus) |

## Latest

Reported in [[ithaca/news/day-3649-sparta]]: she recognised [[people/telemachus]] before anyone told her who he was, from his likeness to me. She put a drug in the wine that takes away grief for a day, and told the beggar story at the table herself.

## Outstanding

- [ ] She kept an oath for me in a hostile city. That is owed. A gift, when there is anything to give.
- [ ] Note: both of the people who saw through a beggar's disguise were women who knew the face. Plan for that in Ithaca ([[ithaca/homecoming-checklist]]).

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/menelaus.md", "people/telemachus.md", "oaths/tyndareus-oath.md", "ithaca/news/day-3649-sparta.md", "ithaca/homecoming-checklist.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-09" },
  },
  {
    path: "people/peisistratus.md",
    title: "Peisistratus",
    type: "person",
    created: "2026-07-06",
    updated: "2026-07-09",
    status: "active",
    tags: ["pylos", "telemachus"],
    people: ["person:nestor", "person:telemachus", "person:menelaus"],
    places: ["place:pylos", "place:sparta"],
    summary: "Nestor's youngest son. Drove Telemachus from Pylos to Sparta. Not met.",
    body: `## Relationship

Youngest son of [[people/nestor]], not yet married. Too young to have been at Troy. Not met; known only from the reports of [[people/telemachus]]'s journey. Brother of [[people/antilochus]].

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Son of Nestor | Sparta, with Telemachus | Friendly | 2026-07-09, reported |

## Latest

Reported from Pylos ([[ithaca/news/day-3646-pylos]]) and Sparta ([[ithaca/news/day-3649-sparta]]): Nestor gave Telemachus a chariot and horses and sent this son to drive him. Two days on the road, a night at Pherae ([[ithaca/telemachus/route]]). They arrived at [[people/menelaus]]' house together, and he is reported to have spoken for both of them at the gate when Telemachus did not know how to start.

Reported that he wept at Menelaus's table for his brother, who died at Troy.

## Outstanding

- [ ] He is my son's escort and, it sounds like, his first friend of his own age outside the island. That is owed to Nestor's house along with the rest.
- [ ] When the news of Antilochus is given to Nestor, his brother should hear it too.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/nestor.md", "people/telemachus.md", "people/antilochus.md", "people/menelaus.md", "ithaca/news/day-3646-pylos.md", "ithaca/news/day-3649-sparta.md", "ithaca/telemachus/route.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-09" },
  },
  {
    path: "people/diomedes.md",
    title: "Diomedes",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "dormant",
    tags: ["fleet", "troy", "returns"],
    people: ["person:nestor"],
    places: ["place:troy", "place:pylos"],
    summary: "Partner on the night missions at Troy. Reached Argos safely on the fourth day.",
    body: `## Relationship

Son of Tydeus, king in Argos. My partner at Troy for the work done at night: the scouting in the dark when we took Dolon ([[omens/heron-in-the-dark]]), the horses of Rhesus. He chose me for it himself. We worked well together, which is more than I can say for most of the commanders.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| King | Argos | Home; friendly | 2026-07-06, reported (Nestor, via Telemachus) |

## Latest

Reported from Pylos ([[ithaca/news/day-3646-pylos]]): when the fleet split after Troy he sailed with [[people/nestor]], and his ships put in at Argos on the fourth day. Home in a week, with his men.

## Note

Some days I can read this entry without doing the arithmetic. Not today. Same war, same plunder, same gods to answer to: four days to his harbour and ten years to my raft.

## Outstanding

- [ ] Nothing owed. If a ship is ever needed from the mainland, he is the first man to ask.

Filed under [[people/_index]]. See [[ithaca/telemachus/what-he-heard]].`,
    links: ["people/_index.md", "people/nestor.md", "omens/heron-in-the-dark.md", "ithaca/news/day-3646-pylos.md", "ithaca/telemachus/what-he-heard.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/idomeneus.md",
    title: "Idomeneus",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "dormant",
    tags: ["fleet", "crete", "returns"],
    people: ["person:nestor"],
    places: ["place:troy", "place:pylos"],
    summary: "King of Crete. Brought every one of his men home who had survived the war. Lost none at sea.",
    body: `## Relationship

Son of Deucalion, grandson of [[people/minos]], king of Crete. A commander at Troy, older than most, steady in council.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| King | Crete | Home; friendly | 2026-07-06, reported (Nestor, via Telemachus) |

## Latest

Reported from Pylos: he brought all of his companions home to Crete who had come through the war. The sea took not one of them from him.

## Note

I keep this beside the crew ledger ([[crew/fleet-strength]]) on purpose.

| Commander | Embarked from Troy | Home |
| --- | --- | --- |
| Idomeneus | his whole contingent | his whole contingent |
| Odysseus | 600 | 0 |

The difference is not that his gods were kinder. Some of it is; not all. He did not raid Ismarus on the way ([[decisions/raid-ismarus]]), did not stay on a beach for wine ([[decisions/stay-the-night-at-ismarus]]), and did not shout his name at anyone ([[decisions/name-at-the-stern]]). See [[crew/_index]].

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/minos.md", "crew/_index.md", "crew/fleet-strength.md", "decisions/raid-ismarus.md", "decisions/stay-the-night-at-ismarus.md", "decisions/name-at-the-stern.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/philoctetes.md",
    title: "Philoctetes",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "dormant",
    tags: ["fleet", "troy", "returns"],
    people: ["person:nestor"],
    places: ["place:troy"],
    summary: "The best archer at Troy. Left on Lemnos with the wound for nine years. Home safe, by Nestor's report.",
    body: `## Relationship

Son of Poeas, keeper of the bow of Heracles. Bitten by a snake on the way to Troy; the wound would not heal and the smell of it was unbearable, and the army put him ashore on Lemnos and sailed on without him. I was part of that council. He was brought to Troy in the last year because the city could not be taken without that bow.

He outshot me at Troy. He was the one man there who did. See [[people/heracles]].

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Archer, commander | Home | Home safe | 2026-07-06, reported (Nestor, via Telemachus) |

## Note

A decision made for the army's sake and paid for by one man, alone on an island for nine years, with a wound. I have had seven on an island with no wound and comfortable quarters ([[ogygia/island/cave]]), and I know what the years do. I did not know it when I voted.

## Outstanding

- [ ] Something is owed for Lemnos. I do not yet know what or how to give it. Recorded so it is not forgotten.

Filed under [[people/_index]]. Report from [[people/nestor]], in [[ithaca/news/day-3646-pylos]].`,
    links: ["people/_index.md", "people/heracles.md", "people/nestor.md", "ogygia/island/cave.md", "ithaca/news/day-3646-pylos.md"],
    fields: { standing: "owed", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/neoptolemus.md",
    title: "Neoptolemus",
    type: "person",
    created: "2019-03-02",
    updated: "2026-07-06",
    status: "dormant",
    tags: ["fleet", "troy", "returns"],
    people: ["person:nestor"],
    places: ["place:troy", "place:acheron"],
    summary: "Achilles' son. I fetched him from Scyros. Fought in the front rank; brought the Myrmidons home.",
    body: `## Relationship

Son of [[people/achilles]]. After his father died I sailed to Scyros and brought him to Troy myself. In council he spoke first and never missed the point, and only Nestor and I were better at it. In the horse he did not go pale or wipe his eyes as the others did; he kept asking to be let out.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Commander of the Myrmidons | Home | Home safe | 2026-07-06, reported (Nestor, via Telemachus) |

## The record

- **Day 620.** Told his father everything above, at the pit ([[voyage/legs/house-of-the-dead]]). It was the only thing I had to give Achilles and he went away glad of it.
- **2026-07-06.** Reported from Pylos ([[ithaca/news/day-3646-pylos]]): he brought the Myrmidons home.

## Outstanding

- [ ] One thing Achilles did not hear: that the son is home. There is no way to tell him. Recorded.
- [ ] [[people/peleus]] may have had his grandson back by now. If there is ever word of Peleus, it may come by this house.

Filed under [[people/_index]]. See [[knowledge/order-of-the-shades]].`,
    links: ["people/_index.md", "people/achilles.md", "people/peleus.md", "voyage/legs/house-of-the-dead.md", "ithaca/news/day-3646-pylos.md", "knowledge/order-of-the-shades.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/peleus.md",
    title: "Peleus",
    type: "person",
    created: "2018-03-24",
    updated: "2026-07-09",
    status: "dormant",
    tags: ["fleet", "asked-after"],
    places: ["place:acheron"],
    summary: "Achilles' father, in Phthia. Achilles asked after him among the dead. I had no news; I still have none.",
    body: `Asked after; no news.

## Relationship

Father of [[people/achilles]], king in Phthia, old when his son sailed. Never met at length.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| King | Phthia | Unknown | none received |

## Why he has a record

At the pit on day 620 ([[voyage/legs/house-of-the-dead]]) Achilles asked two things. Whether his son had gone on to the war, and whether his father still held his place among the Myrmidons, or whether, being old, he was dishonoured now that there was no son at home to stand by him.

I could answer the first. I had nothing on the second.

## Outstanding

- [ ] Still nothing. Neither the Pylos nor the Sparta news has mentioned him ([[ithaca/news/day-3646-pylos]], [[ithaca/news/day-3649-sparta]]).
- [ ] If [[people/neoptolemus]] has reached home, then Peleus has his grandson. That is an inference, not news, and is filed as such.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/achilles.md", "people/neoptolemus.md", "voyage/legs/house-of-the-dead.md", "ithaca/news/day-3646-pylos.md", "ithaca/news/day-3649-sparta.md"],
    fields: { standing: "unknown", confidence: "seen", last_news: "none" },
  },
  {
    path: "people/palamedes.md",
    title: "Palamedes",
    type: "person",
    created: "2019-03-02",
    updated: "2019-03-02",
    status: "closed",
    tags: ["fleet", "sailing", "troy"],
    people: ["person:telemachus", "person:penelope"],
    places: ["place:ithaca", "place:troy"],
    summary: "Came to Ithaca to enlist me for Troy, and put my infant son in front of the plough. Died at Troy.",
    body: `## Relationship

Son of Nauplius. He came to Ithaca with the embassy that gathered the kings for Troy, on the strength of [[oaths/tyndareus-oath]].

I did not want to go. I yoked an ox and an ass to the plough and sowed the furrows with salt, to be taken for a man out of his mind. He took [[people/telemachus]] from [[people/penelope]]'s arms and laid him on the ground in front of the team. I turned the plough aside. That was the whole proof he needed.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Commander | Dead, at Troy | Dead | before the fall of Troy, seen |

## Note

He was right. I was not mad, and I would have kept my son out of the way of a plough in any state of mind. Everything after that, twenty years of it, starts in that field. See [[ithaca/telemachus/remembered]].

He died at Troy by the army's sentence. I am not going to write my part in that here; it is a matter for a different kind of record than a contact card, and the people who could judge it are dead.

## Outstanding

Nothing that can be paid.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/telemachus.md", "people/penelope.md", "oaths/tyndareus-oath.md", "ithaca/telemachus/remembered.md"],
    fields: { standing: "dead", confidence: "seen", last_news: "before the fall of Troy" },
  },
  {
    path: "people/calchas.md",
    title: "Calchas",
    type: "person",
    created: "2019-03-02",
    updated: "2019-03-02",
    status: "dormant",
    tags: ["fleet", "seer", "forecast"],
    people: ["person:teiresias"],
    places: ["place:troy"],
    summary: "Seer to the army at Troy. Forecast ten years at Aulis, from the snake and the sparrows. Correct to the year.",
    body: `## Relationship

Son of Thestor, the army's seer, who brought the ships to Troy by his reading.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Seer to the army | Unknown | Unknown since the fall | 2016-07-12, seen |

## His forecast at Aulis

At the spring under the plane tree, before the fleet sailed, a snake came out from under the altar and climbed to a sparrow's nest in the branches. It ate the eight young and then the mother: nine in all. Then it was turned to stone. Calchas read it at once ([[omens/aulis-serpent]]): nine years of war, and the city taken in the tenth.

| Forecast | Outcome |
| --- | --- |
| Nine years of fighting | Nine |
| Troy falls in the tenth | Fell on day 0 |

## Note

Kept beside [[people/halitherses]] and [[people/teiresias]] ([[knowledge/teiresias-forecast]]). Three seers, three forecasts, all of them right on the numbers. I do not take that as a reason to stop planning; I take it as a reason to plan as if the forecast is the floor.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/halitherses.md", "people/teiresias.md", "omens/aulis-serpent.md", "knowledge/teiresias-forecast.md"],
    fields: { standing: "unknown", confidence: "seen", last_news: "2016-07-12", day: 0 },
  },
  {
    path: "people/ajax-son-of-oileus.md",
    title: "Ajax, son of Oileus",
    type: "person",
    created: "2026-07-09",
    updated: "2026-07-09",
    status: "closed",
    tags: ["fleet", "returns", "poseidon"],
    people: ["person:poseidon", "person:menelaus", "person:athena"],
    places: ["place:troy"],
    summary: "The lesser Ajax. Drowned on the way home after boasting he had escaped the sea in spite of the gods.",
    body: `## Relationship

Son of Oileus, leader of the Locrians. The lesser Ajax, as the army had it: fast, small and quick to anger. Not to be confused with [[people/ajax-son-of-telamon]].

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Commander, Locris | Dead, at sea | Dead | 2026-07-09, reported (Proteus, via Menelaus) |

## How he died, as reported

[[people/athena]] had turned against him for what was done in her temple the night Troy fell. Even so, [[people/poseidon]] first brought him safe to the rocks at Gyrae out of the wreck. He would have lived, but he boasted aloud that he had escaped the gulf of the sea in spite of the gods. Poseidon heard, struck the rock he was clinging to with the trident and split it, and he went down with the piece that broke away.

Source: [[people/proteus]], to [[people/menelaus]], to [[people/telemachus]], to me. Four links.

## Note

Saved, and then drowned for saying so out loud. The relevant entry in my own file is [[decisions/name-at-the-stern]]. On the raft there will be nobody to say it to, which helps. The risk itself: [[studies/poseidon-risk]].

Filed under [[people/_index]]. Report: [[ithaca/news/day-3649-sparta]].`,
    links: ["people/_index.md", "people/ajax-son-of-telamon.md", "people/athena.md", "people/poseidon.md", "people/proteus.md", "people/menelaus.md", "people/telemachus.md", "decisions/name-at-the-stern.md", "studies/poseidon-risk.md", "ithaca/news/day-3649-sparta.md"],
    fields: { standing: "dead", confidence: "reported", last_news: "2026-07-09" },
  },
  {
    path: "people/orestes.md",
    title: "Orestes",
    type: "person",
    created: "2018-03-24",
    updated: "2026-07-06",
    status: "active",
    tags: ["fleet", "asked-after", "mycenae"],
    people: ["person:nestor", "person:telemachus"],
    places: ["place:acheron", "place:pylos"],
    summary: "Agamemnon's son. His father asked after him among the dead. Reported since to have avenged him.",
    body: `## Relationship

Son of [[people/agamemnon]]. A child when the fleet sailed. Never met as a man.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| King | Mycenae | Home; has avenged his father | 2026-07-06, reported (Nestor, via Telemachus) |

## The record

- **Day 620.** At the pit ([[voyage/day-620-acheron]]), Agamemnon asked whether I had heard anything of his son: in Orchomenus, or Pylos, or with Menelaus in Sparta. I had heard nothing and said so, and would not guess.
- **2026-07-06.** Reported from Pylos ([[ithaca/news/day-3646-pylos]]): in the eighth year after the murder he came home from Athens and killed [[people/aegisthus]], and held the funeral feast for him and for his mother, [[people/clytemnestra]].

## Note

Nestor holds him up to [[people/telemachus]] as the son who acted. Reported that he did so at length. I would rather my son came home alive from Sparta than came home a story. See [[ithaca/telemachus/return-risk]].

## Outstanding

- [ ] Agamemnon will never hear this from me. Recorded so the question he asked has an answer somewhere.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/agamemnon.md", "people/aegisthus.md", "people/clytemnestra.md", "people/telemachus.md", "voyage/day-620-acheron.md", "ithaca/news/day-3646-pylos.md", "ithaca/telemachus/return-risk.md"],
    fields: { standing: "friendly", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/aegisthus.md",
    title: "Aegisthus",
    type: "person",
    created: "2018-03-24",
    updated: "2026-07-06",
    status: "closed",
    tags: ["mycenae", "warning", "hall"],
    people: ["person:penelope"],
    places: ["place:acheron"],
    summary: "Took Agamemnon's house and wife while he was at Troy, and killed him at the homecoming feast. Dead.",
    body: `## Relationship

Son of Thyestes. Never met. Stayed at home while the army sailed, courted Agamemnon's wife in his absence, and won her. When Agamemnon came home he invited him to a feast and killed him at it, as a man kills an ox at the manger.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Usurper | Dead | Dead, killed by Orestes | 2026-07-06, reported |

Sources: [[people/agamemnon]] at the pit (day 620, seen and told); Nestor at Pylos (reported, [[ithaca/news/day-3646-pylos]]). They agree.

## Why this is in my file

Because the shape of it is the shape of my own hall ([[ithaca/suitors/their-case]]). A man stays home while the kings are at war; he moves into another man's house; he decides the husband is not coming back and acts accordingly. He reigned seven years on the strength of that decision, and in the eighth [[people/orestes]] came home.

I note the difference that matters: [[people/penelope]] has not chosen, and has spent three years at a loom ([[ithaca/loom/shroud]]) making sure she does not have to.

## Outstanding

Nothing. Kept as a pattern, not a person.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/agamemnon.md", "people/orestes.md", "people/penelope.md", "ithaca/news/day-3646-pylos.md", "ithaca/suitors/their-case.md", "ithaca/loom/shroud.md"],
    fields: { standing: "dead", confidence: "reported", last_news: "2026-07-06" },
  },
  {
    path: "people/clytemnestra.md",
    title: "Clytemnestra",
    type: "person",
    created: "2018-03-24",
    updated: "2026-07-06",
    status: "closed",
    tags: ["mycenae", "warning"],
    people: ["person:penelope"],
    places: ["place:acheron"],
    summary: "Agamemnon's wife. Helped Aegisthus kill him at the feast. Dead, by Nestor's account.",
    body: `## Relationship

Daughter of Tyndareus, sister of [[people/helen]], wife of [[people/agamemnon]]. Never met beyond the courtesies before the war.

## Last known standing

| Role | Location | Standing | Last news |
| --- | --- | --- | --- |
| Queen | Dead | Dead | 2026-07-06, reported |

## The record

- **Day 620.** Agamemnon at the pit ([[voyage/day-620-acheron]]): she helped [[people/aegisthus]] kill him at the feast, killed the Trojan woman Cassandra beside him with her own hands, and would not close his eyes or his mouth as he went down to the dead.
- **2026-07-06.** Reported from Pylos ([[ithaca/news/day-3646-pylos]]): [[people/orestes]] held a funeral feast for her and for Aegisthus on the day he came back. The report does not say how she died, and I do not add it.

## Note

Agamemnon's warning came out of this record: trust no woman, land in secret. He took Penelope out of it himself in the same speech. I keep the warning on his record and keep it off hers ([[ithaca/household/penelope-standing]]).

## Outstanding

Nothing.

Filed under [[people/_index]].`,
    links: ["people/_index.md", "people/helen.md", "people/agamemnon.md", "people/aegisthus.md", "people/orestes.md", "voyage/day-620-acheron.md", "ithaca/news/day-3646-pylos.md", "ithaca/household/penelope-standing.md"],
    fields: { standing: "dead", confidence: "reported", last_news: "2026-07-06" },
  },
];
