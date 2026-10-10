// Library domain: notes. See ../README.md and ./types.ts.
//
// The layer between the folders: threads that belong to four topics at once,
// lists started on a bad night, captures never filed, a draft the register
// later corrected, and a few pages that stop mid-thought. Deliberately uneven;
// the defects are declared in `notesKnownIssues` at the bottom.

import type { KnownIssues, LibraryDocument } from "./types.js";

export const notesDocuments: LibraryDocument[] = [
  // Threads: one idea, many folders.
  {
    path: "notes/threads/rope.md",
    title: "Rope, and what it held",
    type: "thread",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "open",
    tags: ["rope", "threads"],
    people: ["person:penelope", "person:calypso"],
    places: ["place:sirens", "place:aeolia", "place:ogygia"],
    summary: "Everything that went right on this voyage was tied, and most of what went wrong was something coming untied.",
    body: `Started this while bending the halyard on, because my hands knew the knot before I did.

Everything that has gone right on this voyage was tied, and most of what went wrong was something coming untied.

- The lines on the raft, from her stores: [[cordage]]. Braces, halyard, sheets. Checked twice; checked a third time at the water's edge.
- The mast at the Sirens. I asked to be bound, and bound tighter if I begged ([[oaths/sirens-binding-order]]). The rope held me to an order I gave while I was still sane. See [[knowledge/sirens]].
- The silver cord on the bag of winds ([[crew/aeolia-bag]]). The one knot I did not watch. I tied it myself and then slept beside it.
- The three lotus-eaters tied under the benches ([[decisions/drag-back-the-lotus-eaters]]). Rope as mercy. They did not thank anyone.
- The stern cable in the Laestrygonian harbour, cut with my own sword ([[decisions/cut-the-cable]]). The only time cutting a rope saved anyone, and only because we had moored outside ([[knowledge/mooring]]).
- The string of the bow of Eurytus, unstrung in the storeroom for twenty years ([[ithaca/stores/bow-of-eurytus]]). I do not know who has tried to string it.
- Thread. Penelope's shroud, unpicked every night for three years ([[ithaca/loom/shroud]]). Calypso's loom, which made the sail ([[ogygia/routine/loom]]). A thread is a rope nobody has twisted yet.

Not sure what this adds up to. Possibly only that I trust a knot more than a promise, which is not a thing to say aloud to either of them.`,
    links: [
      "ogygia/workshop/cordage.md",
      "oaths/sirens-binding-order.md",
      "knowledge/sirens.md",
      "crew/aeolia-bag.md",
      "decisions/drag-back-the-lotus-eaters.md",
      "decisions/cut-the-cable.md",
      "knowledge/mooring.md",
      "ithaca/stores/bow-of-eurytus.md",
      "ithaca/loom/shroud.md",
      "ogygia/routine/loom.md",
    ],
  },
  {
    path: "notes/threads/sleep.md",
    title: "Sleep, and what was decided without me",
    type: "thread",
    created: "2019-07-19",
    updated: "2026-07-10",
    status: "open",
    tags: ["sleep", "mistakes"],
    people: ["person:elpenor"],
    places: ["place:aeolia", "place:aeaea", "place:thrinacia", "place:ogygia"],
    summary: "Each time I have slept at the wrong moment, the voyage was decided without me. The headland is where I stopped sleeping.",
    body: `Begun in the first week here, when I could not sleep at all, and added to since.

| When | Who slept | What it cost |
| --- | --- | --- |
| Day 171 | I did, at the sheet, Ithaca in sight | the bag opened ([[voyage/day-171-ithaca-in-sight]]) |
| Day 611 | [[elpenor]], on Circe's roof, still drunk | his neck ([[voyage/day-611-elpenor]]) |
| Day 1,077 | I did, inland, praying out of the wind | the herds, the oath, every man left ([[voyage/day-1077-the-cattle]]) |
| Ogygia | nobody, most nights | only the nights |

Nine days I held the sheet ([[decisions/keep-the-helm-nine-days]]) and the tenth I could not. On Thrinacia I went inland to pray and the gods poured sleep on me. I have stopped calling either of those bad luck. They are the same thing twice: the moment I stop watching, someone else decides.

Elpenor is different. He slept where nobody should sleep and woke to the noise of us leaving. Nobody decided anything; he simply stepped the wrong way.

The lotus belongs here somehow ([[knowledge/lotus]]). Not sleep, but a kind of waking that does not want anything.

On Ogygia I stopped sleeping well around the second year. Mornings on the [[ogygia/island/headland]]. Day 3,634, wept and came down at dark ([[journal/day-3634]]).

The crossing is seventeen days with nobody to wake me. The arithmetic is in [[studies/sleep-on-a-single-hand-crossing]]. This page is only the pattern.`,
    links: [
      "voyage/day-171-ithaca-in-sight.md",
      "voyage/day-611-elpenor.md",
      "voyage/day-1077-the-cattle.md",
      "decisions/keep-the-helm-nine-days.md",
      "knowledge/lotus.md",
      "ogygia/island/headland.md",
      "journal/day-3634.md",
      "studies/sleep-on-a-single-hand-crossing.md",
    ],
  },
  {
    path: "notes/threads/names.md",
    title: "Names",
    type: "thread",
    created: "2016-10-20",
    updated: "2026-06-24",
    status: "open",
    tags: ["names", "cyclopes", "crew"],
    people: ["person:polyphemus", "person:argos"],
    places: ["place:cyclopes", "place:acheron"],
    summary: "Nobody in the cave, my own name from the stern, the names of the dead said at the sterns, and the dog's name.",
    body: `I gave a false name and it got six men and me out of the cave. I gave my real one and it cost the rest.

- **Nobody.** [[decisions/nobody-as-the-name]]. The instruction to myself was written down ([[notes/do-not-give-my-name]]) and I kept it for exactly as long as the danger lasted.
- **Mine, shouted.** [[decisions/name-at-the-stern]]. [[polyphemus]] needed the name to pray with ([[oaths/polyphemus-curse]]). Without it his father had nobody to punish. With it, I have an address.
- **The dead.** At every stern before sailing, each lost man's name three times. I stopped after the harbour: four hundred and eighty-four names is not a thing a voice can do in a morning. I say some still. [[crew/antiphus]], the last the Cyclops took. [[crew/polites]]. The list I keep meaning to write is [[notes/lists/names-of-the-dead]].
- **At the pit** the dead knew me only once they had drunk ([[voyage/day-620-acheron]]). My mother looked at me and did not know my name until then.
- **The households** who will want names, not counts ([[crew/families-owed-news]]).
- **The dog.** [[people/argos|The dog]] was named before I sailed. The record of him is a record of no reports ([[ithaca/household/argos]]). I say his name sometimes so it stays in my mouth.

A name is the one thing nobody can take from you and the easiest thing to give away.`,
    links: [
      "decisions/nobody-as-the-name.md",
      "notes/do-not-give-my-name.md",
      "decisions/name-at-the-stern.md",
      "oaths/polyphemus-curse.md",
      "crew/antiphus.md",
      "crew/polites.md",
      "voyage/day-620-acheron.md",
      "crew/families-owed-news.md",
      "ithaca/household/argos.md",
    ],
  },
  {
    path: "notes/threads/salt-and-water.md",
    title: "Salt, water",
    type: "thread",
    created: "2019-07-13",
    updated: "2026-07-08",
    tags: ["sea", "Sea"],
    places: ["place:charybdis", "place:ogygia"],
    body: `Nine days adrift with a sea of water and nothing to drink ([[voyage/day-1088-adrift]]). Learned then what [[knowledge/fevers]] has only as a list.

Charybdis drinks the sea three times a day and gives it back; I hung over her on the fig tree waiting for my keel to come up ([[knowledge/charybdis#the-fig-tree]]). Everything I own now came up out of a whirlpool.

Watering parties were the most dangerous errand of the voyage and the one nobody volunteered for ([[knowledge/watering-parties]]).

The headland in winter: weeping, salt on the face from both directions ([[journal/day-3100]]).

Now: one skin of water aboard, two jars still to carry down ([[ogygia/stores/water]]). [[studies/water-ration]] says it does not cover seventeen days at a working ration. Salt in everything; fresh water in nothing but what I carry.`,
    links: [
      "voyage/day-1088-adrift.md",
      "knowledge/fevers.md",
      "knowledge/watering-parties.md",
      "journal/day-3100.md",
      "ogygia/stores/water.md",
      "studies/water-ration.md",
    ],
  },
  {
    path: "notes/threads/wine.md",
    title: "Wine, from Maron onwards",
    type: "thread",
    created: "2016-07-22",
    updated: "2026-07-11",
    status: "open",
    tags: ["wine", "ismarus", "threads"],
    people: ["person:polyphemus", "person:calypso"],
    places: ["place:ismarus", "place:cyclopes", "place:ogygia", "place:ithaca"],
    summary: "The wine that cost seventy-two at Ismarus bought six lives in the cave. Every skin since has been a gift from someone I could not repay.",
    body: `Opened the morning after Ismarus. I keep adding to it.

1. **Ismarus.** The men would not leave the wine and the Cicones came at dawn: seventy-two ([[decisions/stay-the-night-at-ismarus]], [[crew/losses/ismarus]]).
2. **Maron's twelve jars.** Given for sparing his household ([[maron]], [[oaths/maron-guest-gift]]). One cup to twenty of water and still the strongest thing I have drunk. Rationed from the next day ([[crew/ismarus-wine-ration]]).
3. **The cave.** Three bowls of it, undiluted, to the Cyclops, and he asked my name and slept ([[journal/day-97]]). The same wine that killed seventy-two saved six. I have never found a way to write that sentence so it balances.
4. **Elpenor.** Drunk, on the roof. See the sleep thread.
5. **Ogygia.** One skin aboard from her stores, a second offered ([[ogygia/stores/wine]]).
6. **Ithaca.** Eight hundred and twelve jars of the thousand reported gone down the suitors' throats ([[ithaca/stores/wine]]).

Meant to write up where Maron's wine came from and why it was that strong: [[knowledge/wine-of-maron]]. Never did.`,
    links: [
      "decisions/stay-the-night-at-ismarus.md",
      "crew/losses/ismarus.md",
      "oaths/maron-guest-gift.md",
      "crew/ismarus-wine-ration.md",
      "journal/day-97.md",
      "ogygia/stores/wine.md",
      "ithaca/stores/wine.md",
      "knowledge/wine-of-maron.md",
    ],
  },
  {
    path: "notes/threads/smoke.md",
    title: "Smoke",
    type: "thread",
    status: "open",
    created: "2017-03-16",
    updated: "2025-01-06",
    tags: ["fire"],
    places: ["place:aeaea", "place:ithaca", "place:ogygia"],
    summary: "Smoke over Aeaea, the fires on Ithaca, the stake in the coals, Elpenor's pyre and her hearth.",
    body: `Smoke from deep in the woods on Aeaea, the second day ([[voyage/day-246-aeaea-arrival]]). I climbed to look and came back down with a stag instead of an answer.

The fires on Ithaca. Men tending them on the shore on the tenth day, and I slept ([[decisions/keep-the-helm-nine-days]]). The nearest I have been in twenty years is a smell of someone else's fire.

The olive stake, its point hardened in the coals ([[decisions/blind-rather-than-kill]]).

The ram's thighs burned on the beach, and the smoke went up and was not taken ([[omens/day-99-ram-refused]]).

Elpenor burned with his armour on the headland ([[voyage/day-624-elpenor-buried]]).

The ship struck, sulphur and smoke over the whole deck ([[voyage/day-1084-the-storm]]).

Her hearth: cedar and juniper, and the smoke carries across the island ([[ogygia/island/hearth]]). Seven years of the best fire I have sat beside and it smells of nowhere.`,
    links: [
      "voyage/day-246-aeaea-arrival.md",
      "decisions/keep-the-helm-nine-days.md",
      "decisions/blind-rather-than-kill.md",
      "omens/day-99-ram-refused.md",
      "voyage/day-624-elpenor-buried.md",
      "voyage/day-1084-the-storm.md",
      "ogygia/island/hearth.md",
    ],
  },
  {
    path: "notes/threads/oars.md",
    title: "Oars",
    type: "thread",
    created: "2018-03-29",
    updated: "2026-07-09",
    status: "open",
    tags: ["oars", "crew", "teiresias"],
    people: ["person:elpenor", "person:teiresias"],
    places: ["place:aeaea", "place:scylla", "place:ogygia"],
    summary: "Elpenor's oar on his barrow, the oar Teiresias says I must carry inland, the benches re-seated after every loss, and the one oar I have now.",
    body: `Elpenor asked for his oar on his barrow, the one he pulled with his friends while he lived. It is there ([[crew/barrow-on-aeaea]]). The only grave of the six hundred has an oar for a headstone.

Teiresias laid another oar on me: after the house is in order, carry one inland until someone asks why I have a winnowing fan on my shoulder ([[oaths/teiresias-inland-journey]]). An oar that ends my sailing by being mistaken for something else.

The benches. Each loss meant re-seating them, and the rota shows it ([[crew/oar-bench-rota]], [[knowledge/oar-counts]]). After the strait I gave the order to row and did not change it ([[voyage/day-1043-strait#scylla]]). Thirty-one oars working where thirty-seven had.

Past the Sirens the rowing was the whole plan: wax and oars, and me tied ([[voyage/day-1041-sirens]]).

My helmsman died at the steering oar when the mast came down on him ([[crew/helmsmen]]).

Now one oar, the steering oar on the raft ([[ogygia/build/steering-oar]]). [[elpenor]] would have something to say about a ship with no benches.`,
    links: [
      "crew/barrow-on-aeaea.md",
      "oaths/teiresias-inland-journey.md",
      "crew/oar-bench-rota.md",
      "knowledge/oar-counts.md",
      "voyage/day-1041-sirens.md",
      "crew/helmsmen.md",
      "ogygia/build/steering-oar.md",
    ],
  },
  {
    path: "notes/threads/the-number-six.md",
    title: "Six",
    type: "thread",
    status: "open",
    summary: "Six from each ship, six from the cave, six from the deck, six days of feasting, six poplars in the raft.",
    created: "2019-07-02",
    updated: "2026-07-08",
    tags: ["numbers"],
    places: ["place:ismarus", "place:cyclopes", "place:scylla", "place:thrinacia"],
    body: `Six from each ship at Ismarus ([[crew/losses/ismarus]]).
Six from ship 1 in the cave ([[crew/losses/cyclopes]]).
Six heads, six men, off the deck in the strait ([[knowledge/scylla]], [[crew/scylla-six]]).
Six days of feasting on Thrinacia before the wind dropped ([[voyage/day-1083-sixth-day]]).
Six poplars in the raft ([[ogygia/build/timber-log]]).

It is not an omen. It is that losses come in the sizes of the thing doing the taking: a ship's share, a hand's grab, a monster's heads. [[studies/losses-by-hazard]] sorts them properly. I keep this page because the number turns up in my sleep.`,
    links: [
      "crew/losses/ismarus.md",
      "crew/losses/cyclopes.md",
      "knowledge/scylla.md",
      "crew/scylla-six.md",
      "voyage/day-1083-sixth-day.md",
      "ogygia/build/timber-log.md",
      "studies/losses-by-hazard.md",
    ],
  },
  {
    path: "notes/threads/the-number-twelve.md",
    title: "Twelve",
    type: "thread",
    status: "open",
    created: "2016-07-15",
    updated: "2026-06-10",
    tags: ["numbers", "Twelve"],
    places: ["place:troy", "place:ismarus", "place:cyclopes", "place:aeolia", "place:ithaca"],
    summary: "Twelve ships, twelve jars, twelve men into the cave, twelve helmsmen, Aeolus's twelve children, twelve axes, twelve women and twelve suitors from our own island.",
    body: `Started on day 3 as a note about the fleet. It has become something else.

| Twelve | Where | Record |
| --- | --- | --- |
| ships | off the beach at Troy | [[crew/fleet-strength]] |
| helmsmen | one to a ship | [[crew/helmsmen]] |
| jars of Maron's wine | Ismarus | [[crew/ismarus-wine-ration]] |
| men into the cave | ship 1 | [[crew/cave-party]] |
| children of Aeolus | six sons, six daughters | [[people/aeolus]] |
| axe-heads in a line | the hall, before Troy | [[ithaca/stores/twelve-axes]] |
| women gone over | the hall, reported | [[ithaca/household/the-twelve]] |
| suitors from Ithaca itself | reported | [[ithaca/suitors/ithacans]] |

Six and twelve keep turning up together: six from each of twelve ships; six sons and six daughters; six of the twelve came out of the cave.

The twelve on Ithaca are the ones I think about. Twelve women and twelve men of our own island. I do not know the names of either and will not guess.`,
    links: [
      "crew/fleet-strength.md",
      "crew/helmsmen.md",
      "crew/ismarus-wine-ration.md",
      "crew/cave-party.md",
      "people/aeolus.md",
      "ithaca/stores/twelve-axes.md",
      "ithaca/household/the-twelve.md",
      "ithaca/suitors/ithacans.md",
    ],
  },
  {
    path: "notes/threads/gifts-given-and-owed.md",
    title: "Gifts given, gifts owed",
    type: "thread",
    created: "2016-12-01",
    updated: "2026-07-11",
    status: "open",
    tags: ["xenia", "debts"],
    people: ["person:calypso", "person:polyphemus"],
    places: ["place:ismarus", "place:cyclopes", "place:aeolia", "place:ogygia", "place:ithaca"],
    summary: "Every host who gave me something and what I gave back, which is mostly nothing. Started on Aeolia, where the gift was the winds.",
    body: `Started on Aeolia, the month we were guests, because I wanted a list of what we would owe Aeolus ([[oaths/xenia-aeolus]]). The list outlived the friendship.

- **Maron** — wine, gold, a silver bowl. We gave his household its lives. Square, the same day ([[oaths/maron-guest-gift]]).
- **Polyphemus** — his guest-gift was that Nobody would be eaten last ([[oaths/xenia-polyphemus]]). Not a debt. Recorded because it is the only time I have been offered one as a threat.
- **Aeolus** — the winds in a bag. Withdrawn. Nothing given back, and nothing could be.
- **Iphitus** — the bow of Eurytus, before Troy, for a sword and a spear ([[ithaca/stores/bow-of-eurytus]]). We never sat at each other's tables. Meant to write him a page of his own: [[people/iphitus]].
- **Calypso** — seven years of food, the tools, the timber, the cloth, the rope, the directions, the oath ([[ogygia/debts]]). The tools at least go back tomorrow morning ([[ogygia/workshop/tool-return]]).

[[knowledge/guest-gifts]] says a gift is a record of what is owed. By that rule I am the most indebted man on the sea and own a raft.`,
    links: [
      "oaths/xenia-aeolus.md",
      "oaths/maron-guest-gift.md",
      "oaths/xenia-polyphemus.md",
      "ithaca/stores/bow-of-eurytus.md",
      "ogygia/debts.md",
      "ogygia/workshop/tool-return.md",
      "knowledge/guest-gifts.md",
    ],
  },
  {
    path: "notes/threads/told-and-not-believed.md",
    title: "Things I was told and did not believe",
    type: "thread",
    created: "2019-05-20",
    updated: "2026-07-07",
    status: "open",
    tags: ["warnings", "judgement"],
    people: ["person:circe", "person:teiresias", "person:calypso", "person:eurylochus"],
    places: ["place:cyclopes", "place:scylla", "place:thrinacia", "place:ogygia"],
    summary: "The crew said leave the cave. Circe said do not arm. Teiresias said leave the cattle. Calypso said I could go. I believed one of them.",
    body: `Written after the strait, when I had time to be ashamed of it.

**The crew, at the cave.** Take the cheeses and the lambs and go. I wanted to see who lived there ([[decisions/enter-the-cave]]). Logged in [[crew/dissent-log]], which is mostly a list of times they were right.

**[[circe]], about Scylla.** She is not a mortal thing; do not arm. I put on armour and took two spears to the foredeck and never saw where the heads came from ([[decisions/arm-against-scylla]]).

**Teiresias, about the cattle.** This one I believed. I told the crew, and they did not believe me. [[the-forecast]] still holds, and the condition it set has already been broken by other hands.

**Calypso, day 3,647.** She came down and said I could go. I did not believe it until she swore ([[oaths/calypso-no-harm]], [[ogygia/build/day-3647-the-order]]). She was hurt that I asked. I would ask again.

The pattern, if there is one: I disbelieve warnings and I disbelieve kindness, and I believe prophecy, which is the one that cannot be checked until it is too late.`,
    links: [
      "decisions/enter-the-cave.md",
      "crew/dissent-log.md",
      "decisions/arm-against-scylla.md",
      "oaths/calypso-no-harm.md",
      "ogygia/build/day-3647-the-order.md",
    ],
  },
  {
    path: "notes/threads/women-who-wove.md",
    title: "The women who wove",
    type: "thread",
    status: "open",
    created: "2025-11-04",
    updated: "2026-07-11",
    tags: ["loom", "penelope", "calypso"],
    people: ["person:penelope", "person:calypso", "person:circe"],
    places: ["place:ithaca", "place:aeaea", "place:ogygia"],
    summary: "Penelope, Circe and Calypso all at a loom, and each loom bought someone time.",
    body: `The news of the shroud reached me three days ago, and I have been thinking about looms since.

[[people/penelope|Her]] loom: the shroud for Laertes, woven by day and unpicked by night, three years, until one of the women told ([[ithaca/loom/shroud]], [[ithaca/loom/discovery]]). She bought three years with a thread she pulled out every night.

[[circe]] was at her loom singing when Polites heard her through the doors, and said to call out. The singing was the first thing; the drugs came after.

[[calypso]] weaves at a great loom with a golden shuttle and sings while she works ([[ogygia/routine/loom]]). The sail came off it ([[ogygia/workshop/sail-cloth]]).

So: one loom to keep a man from a marriage, one that was the front door of a trap, and one that let me go. I thought on the headland that Penelope bought three years and I have bought nothing ([[journal/day-3618]]). That is still true. But the sail is woven, and it was not woven by me.`,
    links: [
      "ithaca/loom/shroud.md",
      "ithaca/loom/discovery.md",
      "ogygia/routine/loom.md",
      "ogygia/workshop/sail-cloth.md",
      "journal/day-3618.md",
    ],
  },
  {
    path: "notes/threads/mothers.md",
    title: "Mothers",
    type: "thread",
    status: "open",
    summary: "My mother at the pit, the nurse who kept the boy's secret, Penelope told by a herald, and the Cyclops's mother, whom I had never once considered.",
    created: "2018-03-25",
    updated: "2026-07-08",
    tags: ["family"],
    people: ["person:penelope", "person:polyphemus"],
    places: ["place:acheron", "place:ithaca"],
    body: `My mother at the pit. She sat silent until she had drunk, and then she knew me, and told me what had killed her: missing me, and my gentle ways ([[voyage/day-620-acheron]], [[people/anticleia]]). Three times I tried to hold her.

Eurycleia, who nursed me and then the boy, and who provisioned his ship and kept it from his mother ([[people/eurycleia]]).

Penelope, who learned her son had sailed from the herald, not from him. Reported day 3,648.

Thoosa. Polyphemus's mother ([[people/thoosa]]). I have never once thought of her until tonight. Someone's son, blinded, praying to his father ([[oaths/polyphemus-curse]]).

The boy was in his mother's arms when I left ([[ithaca/telemachus/remembered]]). Everything I know of him since came through her household.`,
    links: [
      "voyage/day-620-acheron.md",
      "people/anticleia.md",
      "people/eurycleia.md",
      "people/thoosa.md",
      "oaths/polyphemus-curse.md",
      "ithaca/telemachus/remembered.md",
    ],
  },
  {
    path: "notes/threads/fathers-and-sons.md",
    title: "Fathers and sons",
    type: "thread",
    created: "2018-03-24",
    updated: "2026-07-09",
    tags: ["family", "telemachus"],
    people: ["person:laertes", "person:telemachus", "person:poseidon", "person:polyphemus"],
    places: ["place:ithaca", "place:acheron", "place:pylos"],
    body: `Achilles at the pit asked first about his father, then his son ([[people/peleus]], [[people/neoptolemus]]). I had nothing on Peleus. On the son I could tell him the truth: he fought in the front rank and came home. He went away across the meadow pleased. Nobody can tell me that about mine yet.

Palamedes put my son in front of the plough to prove I was sane ([[people/palamedes]]). The first thing the war took from me was the pretence that I could stay with him.

My father on the farm, working the orchard he walked me through when I was small ([[people/laertes]], [[ithaca/island/orchard]]).

Poseidon is a father avenging a son. I do not find that hard to understand, which does not help ([[people/poseidon]]).

Telemachus has gone to ask other men's fathers about his ([[people/telemachus]]). What would I

Carry on in [[notes/threads/telemachus-and-me]].`,
    links: [
      "people/peleus.md",
      "people/neoptolemus.md",
      "people/palamedes.md",
      "people/laertes.md",
      "ithaca/island/orchard.md",
      "people/poseidon.md",
      "people/telemachus.md",
    ],
  },
  {
    path: "notes/threads/signs-i-ignored.md",
    title: "Signs I ignored",
    type: "thread",
    created: "2019-07-20",
    updated: "2026-07-11",
    status: "open",
    tags: ["omens", "Omens"],
    places: ["place:cyclopes", "place:aeolia", "place:thrinacia", "place:ogygia"],
    summary: "Not signs I misread. Signs I saw, wrote down, and went on as before.",
    body: `- The ram's thighs not accepted ([[omens/day-99-ram-refused]]). I did not know. Fair.
- Aeolus told me plainly what our coming back meant ([[omens/day-172-aeolus-reading]]). I heard it as an insult and not as a reading.
- The gulls on Thrinacia sitting out the wind with us for a month, fat, while we went hungry. Meant to log it: [[omens/day-1062-the-gulls]].
- The hides crawled and the meat lowed on the spits ([[omens/day-1078-hides-crawled]]). Nobody needed a seer. We stayed six days.
- The hawk on the right, carrying ([[omens/day-3646-hawk]]). I filed it without interpretation. That is ignoring with better handwriting.
- The eagle over the courtyard, reported ([[omens/day-3651-eagle]]). Ditto.

[[omens/_index]] has them in order. This page is only the ones where I was the problem.`,
    links: [
      "omens/day-99-ram-refused.md",
      "omens/day-172-aeolus-reading.md",
      "omens/day-1078-hides-crawled.md",
      "omens/day-3646-hawk.md",
      "omens/day-3651-eagle.md",
      "omens/_index.md",
    ],
  },
  {
    path: "notes/threads/hunger.md",
    title: "Hunger",
    type: "thread",
    created: "2019-06-23",
    updated: "2026-07-10",
    tags: ["food", "provisions"],
    people: ["person:penelope"],
    places: ["place:lotus", "place:aeaea", "place:thrinacia", "place:ogygia", "place:ithaca"],
    summary: "The lotus that took away the wish, the stag on Aeaea, the stores gone on Thrinacia, seven years never hungry, and my own herds eaten at home.",
    body: `Begun on Thrinacia in the fifth week of wrong wind, when the stores had been out a fortnight ([[voyage/day-1062-stores-out]], [[crew/thrinacia-provisions]]). Fishing with bent hooks. Birds, anything.

Hunger is what the whole voyage was decided by, more than courage or the gods.

- The lotus: food that takes away the wish to go home ([[knowledge/lotus]]). The opposite of hunger, and worse.
- Aeaea, the second day: a stag across my path, one spear, and a crew that had stopped eating stood up ([[omens/day-246-the-stag]]).
- Thrinacia: the oath held for as long as the stores did.
- Ogygia: seven years never hungry ([[ogygia/routine/meals]]). She eats different food.
- Ithaca: my herds going down the suitors at the reported rate ([[ithaca/stores/drawdown]]).
- The crossing: fifty-one loaves, three a day ([[ogygia/stores/food-bag]], [[studies/provisions-for-seventeen-days]]).

The men on Thrinacia were not wicked. They were hungry and I was asleep.`,
    links: [
      "voyage/day-1062-stores-out.md",
      "crew/thrinacia-provisions.md",
      "knowledge/lotus.md",
      "omens/day-246-the-stag.md",
      "ogygia/routine/meals.md",
      "ithaca/stores/drawdown.md",
      "ogygia/stores/food-bag.md",
      "studies/provisions-for-seventeen-days.md",
    ],
  },
  {
    path: "notes/threads/unrecognised.md",
    title: "Being unrecognised",
    type: "thread",
    status: "draft",
    summary: "Twenty years away. The boy, the dog, my mother's shade and my wife, and what each would need before they knew me.",
    created: "2024-07-05",
    updated: "2026-07-03",
    tags: ["ithaca", "homecoming"],
    people: ["person:telemachus", "person:argos", "person:penelope"],
    places: ["place:ithaca"],
    body: `Twenty years. Nobody on Ithaca under twenty-five remembers my face.

The boy was an infant ([[ithaca/telemachus/remembered]]). He would walk past me.

The dog, if he is alive, will know me before anyone ([[ithaca/household/argos]]). Dogs do not need to be told.

My mother at the pit did not know me until she drank ([[people/anticleia]]). The dead and the very young need help; the living in between will be suspicious, and should be.

Penelope will want proof that is not my face. There is one, and it is [[the-bed]]. Not written here.

On landing: do not announce. [[ithaca/homecoming-checklist]] has an empty line for this. The question is whether I go in as myself or as someone the hall will not bother to

See [[notes/threads/disguise]].`,
    links: [
      "ithaca/telemachus/remembered.md",
      "ithaca/household/argos.md",
      "people/anticleia.md",
      "ithaca/homecoming-checklist.md",
    ],
  },
  // Half-finished threads that trail off.
  {
    path: "notes/threads/islands.md",
    title: "Islands that kept me",
    type: "thread",
    created: "2022-01-02",
    updated: "2022-01-02",
    status: "draft",
    tags: ["islands"],
    places: ["place:aeaea", "place:thrinacia", "place:ogygia"],
    body: `Aeaea kept me a year and then most of another, and it was the crew who asked to leave, not me ([[voyage/legs/aeaea-first-stay]]). Thrinacia kept me forty days with a wind ([[voyage/legs/thrinacia]]). Ogygia has kept me —

A prison with good food is still

Continued (one day) in [[notes/threads/islands-part-2]].`,
    links: ["voyage/legs/aeaea-first-stay.md", "voyage/legs/thrinacia.md"],
  },
  {
    path: "notes/threads/doors.md",
    title: "Doors",
    type: "thread",
    created: "2023-12-03",
    updated: "2023-12-03",
    tags: [],
    places: ["place:cyclopes", "place:ogygia", "place:ithaca"],
    body: `The stone across the cave, too big for twenty wagons ([[knowledge/cyclops-door-stone]]). The vine over her cave mouth, which is not a door and keeps me in better ([[ogygia/island/vine]]). The hall at home, drawn from memory once, doors and all ([[ithaca/hall/plan]]).

Every bad night on this voyage started with walking through a door I should have stood outside. Write up properly: [[knowledge/doors-and-thresholds]].`,
    links: ["knowledge/cyclops-door-stone.md", "ogygia/island/vine.md", "ithaca/hall/plan.md"],
  },
  {
    path: "notes/threads/silence.md",
    title: "Silence",
    type: "thread",
    created: "2020-11-05",
    updated: "2020-11-05",
    tags: ["silence"],
    body: `Ajax would not speak to me at the pit ([[people/ajax-son-of-telamon]]). I would rather he had cursed me.

Thirty-seven men with wax in their ears ([[crew/sirens-wax]]). The quietest hour of the voyage, and I was the only one who heard anything.

At the hearth, the one subject we do not raise ([[ogygia/routine/evenings]]).

What I did not tell the crew about the strait. That one has its own page. What I have not told`,
    links: ["people/ajax-son-of-telamon.md", "crew/sirens-wax.md", "ogygia/routine/evenings.md"],
  },
  // Lists.
  {
    path: "notes/lists/people-who-fed-me.md",
    title: "People who fed me",
    type: "list",
    created: "2020-07-11",
    updated: "2026-07-10",
    status: "open",
    tags: ["lists", "xenia"],
    people: ["person:circe", "person:calypso", "person:eumaeus"],
    places: ["place:ismarus", "place:aeolia", "place:aeaea", "place:ogygia"],
    summary: "Everyone who has put food in front of me since Troy, and the one who had food taken from him.",
    body: `Begun on the first anniversary here, after her feast.

| Who | Where | What |
| --- | --- | --- |
| [[maron]] | Ismarus | wine, and the chance to leave |
| Aeolus | Aeolia | a month of feasting |
| [[circe]] | Aeaea | a year at her table, after the swine |
| [[calypso]] | Ogygia | seven years; bread and wine for the crossing |
| Eumaeus | Ithaca, remembered | swine from the yard when I was young |

Not on the list: Polyphemus. We ate his cheese before he came home. That was taken, not given, and I knew it at the time.

Owed back to every name here. See [[notes/lists/people-i-owe]].`,
    links: ["people/aeolus.md", "people/eumaeus.md", "notes/lists/people-i-owe.md"],
  },
  {
    path: "notes/lists/people-i-owe.md",
    title: "People I owe",
    type: "list",
    created: "2019-07-17",
    updated: "2026-07-11",
    status: "open",
    tags: ["todo", "debts"],
    people: ["person:calypso", "person:athena", "person:eumaeus", "person:elpenor"],
    summary: "Debts with names on them: Calypso, the families, the dead, Athena, the swineherd.",
    body: `- [ ] Calypso — everything ([[ogygia/debts]]).
- [ ] The families of five hundred and sixty-one households, in news ([[crew/families-owed-news]]).
- [ ] Six hundred shares, held for men who cannot collect ([[crew/shares-owed]]).
- [ ] The dead: a barren heifer at Ithaca, the best ram for Teiresias ([[oaths/vow-to-the-dead]]).
- [x] Elpenor — burned, barrow raised, oar set ([[crew/promises-to-the-dead]]).
- [ ] Athena. I do not know what one owes a goddess who has not shown herself to me since Troy.
- [ ] Eumaeus, for twenty years of keeping the count honest, if the reports are right.`,
    links: [
      "ogygia/debts.md",
      "crew/families-owed-news.md",
      "crew/shares-owed.md",
      "oaths/vow-to-the-dead.md",
      "crew/promises-to-the-dead.md",
      "people/athena.md",
      "people/eumaeus.md",
    ],
  },
  {
    path: "notes/lists/every-lie-i-told.md",
    title: "Every lie I told",
    type: "list",
    status: "draft",
    summary: "Started at the end and working backwards. Five so far, one of them a silence.",
    created: "2023-07-12",
    updated: "2026-06-24",
    tags: ["lies"],
    places: ["place:ithaca", "place:cyclopes", "place:aeolia"],
    body: `Not finished. Started at the end and working backwards, which is the wrong way round.

1. My name is Nobody ([[decisions/nobody-as-the-name]]).
2. To Polyphemus: that Poseidon broke our ship on his coast and we were all that was left. A lie then. It has since come true of every ship I had, near enough.
3. To the crew: nothing about what was in the bag ([[crew/aeolia-bag]]). Not a lie. A silence that did the same work.
4. To the crew: everything about the Sirens and nothing about Scylla ([[decisions/what-to-tell-the-crew]]).
5. At home, to Palamedes, with a plough and salt: that I was mad ([[people/palamedes]]).
6.`,
    links: ["decisions/nobody-as-the-name.md", "crew/aeolia-bag.md", "decisions/what-to-tell-the-crew.md", "people/palamedes.md"],
  },
  {
    path: "notes/lists/nights-i-nearly-gave-up.md",
    title: "Every night I nearly gave up",
    type: "list",
    status: "recorded",
    created: "2025-01-06",
    updated: "2026-06-24",
    tags: ["lists"],
    places: ["place:aeolia", "place:laestrygonians", "place:aeaea", "place:charybdis", "place:ogygia"],
    summary: "Six nights, by day number. Written down so the next one has company.",
    body: `- **Day 171.** Woke to the winds out and Ithaca going astern. Thought about going over the side and letting the sea finish it. Lay down under my cloak instead ([[voyage/day-171-ithaca-in-sight]]).
- **Day 172.** Aeolus at the door, telling us to go ([[voyage/day-172-aeolus-refuses]]).
- **Day 206.** One ship ([[crew/roll-calls/day-206]]).
- **Aeaea, the last week.** Circe said the next stop was the dead. Sat on the bed and wept and did not want to see the sun.
- **Day 1,085.** On the fig tree, waiting for the keel ([[voyage/day-1085-the-fig-tree]]).
- **Day 3,100 and day 3,634.** The headland ([[journal/day-3100]], [[journal/day-3634]]).

Each time, the next morning had a task in it. That is the whole of the method.`,
    links: [
      "voyage/day-171-ithaca-in-sight.md",
      "voyage/day-172-aeolus-refuses.md",
      "crew/roll-calls/day-206.md",
      "voyage/day-1085-the-fig-tree.md",
      "journal/day-3100.md",
      "journal/day-3634.md",
    ],
  },
  {
    path: "notes/lists/questions-for-telemachus.md",
    title: "Questions for Telemachus",
    type: "list",
    status: "open",
    summary: "Six questions for the son I have never spoken to, in the order not to ask them.",
    created: "2026-07-06",
    updated: "2026-07-09",
    tags: ["ithaka"],
    people: ["person:telemachus"],
    body: `- What did Nestor say about me that he would not say to my face?
- What did Menelaus say?
- Who taught you to sail?
- Who do you trust in the hall?
- Did your mother know you were going?
- Do you want me back, or do you want the hall empty?

Do not ask the last one first. Cross-check with [[ithaca/questions-on-landing]] and [[ithaca/telemachus/what-he-heard]].`,
    links: ["ithaca/questions-on-landing.md", "ithaca/telemachus/what-he-heard.md"],
  },
  {
    path: "notes/lists/what-i-will-not-tell-penelope.md",
    title: "What I will not tell Penelope",
    type: "list",
    summary: "Four things, kept from her on purpose, and the reason for each.",
    created: "2026-06-10",
    updated: "2026-07-11",
    status: "draft",
    tags: ["penelope"],
    people: ["person:penelope", "person:calypso"],
    body: `- The offer, and that I refused it ([[ogygia/the-offer]]). Not because I was tempted. Because a refusal of immortality told at one's own hearth is a boast.
- What the Sirens offered. To know everything. She should not have to wonder whether I wanted that more than home.
- How close the raft was to never being built.
- The count, in any form she has to carry.

Everything else she may ask, and I will answer. See [[people/penelope]].`,
    links: ["ogygia/the-offer.md", "people/penelope.md"],
  },
  // Not sure where these go.
  {
    path: "notes/not-sure-where-this-goes.md",
    title: "Not sure where this goes",
    type: "note",
    created: "2025-11-03",
    updated: "2025-11-03",
    tags: ["unfiled"],
    places: ["place:thrinacia", "place:ithaca"],
    body: `Not sure where this goes. Thrinacia or Ithaca. Both.

My men ate a god's cattle while I slept, after swearing not to ([[decisions/cattle-of-helios]], [[knowledge/thrinacia-cattle]]). The suitors are eating my cattle while I am away, and nobody made them swear anything ([[ithaca/stores/cattle]], [[ithaca/stores/drawdown]]). Ninety-six reported gone of seven hundred and twenty.

I know what happened to the men on Thrinacia. I do not want to be the god in the second story. I am afraid I will be.`,
    links: ["decisions/cattle-of-helios.md", "knowledge/thrinacia-cattle.md", "ithaca/stores/cattle.md", "ithaca/stores/drawdown.md"],
  },
  {
    path: "notes/unfiled-lotus-and-ogygia.md",
    title: "Unfiled: is this the lotus, slower?",
    type: "note",
    created: "2023-07-13",
    updated: "2023-07-13",
    tags: ["lotus", "ogygia", "unfiled"],
    body: `Not sure where this goes. The lotus page or the Ogygia years.

The three on the lotus coast stopped wanting to go home after one meal ([[crew/lotus-eaters]], [[knowledge/lotus]]). I have eaten well here for four years. I still want to go home. But I notice I want it at the same strength every morning, which is to say it has stopped growing ([[ogygia/routine/household]]).

Tied them under the benches. Nobody here to tie me.`,
    links: ["crew/lotus-eaters.md", "knowledge/lotus.md", "ogygia/routine/household.md"],
  },
  {
    path: "notes/unfiled-sirens-and-the-singer.md",
    title: "Not sure where this goes either",
    type: "note",
    created: "2026-02-10",
    updated: "2026-02-10",
    tags: [],
    body: `The Sirens sang me Troy, the whole of it, everything we suffered there ([[knowledge/sirens]], [[voyage/day-1041-sirens]]). The best song I have heard, and it would have killed me.

Phemius is reported singing the returns from Troy in my hall, and Penelope asked him to stop ([[ithaca/household/phemius]]).

Two singers, the same subject. One wanted me dead and one is made to sing for men who want me dead. Not sure if this is a Sirens note or an Ithaca note.`,
    links: ["knowledge/sirens.md", "voyage/day-1041-sirens.md", "ithaca/household/phemius.md"],
  },
  // Near-duplicates kept as history.
  {
    path: "notes/losses-tally-draft.md",
    title: "Losses so far (draft)",
    type: "note",
    created: "2019-07-17",
    updated: "2019-07-28",
    status: "superseded",
    tags: ["crew", "ledger"],
    summary: "The first tally, written from memory in the first week here. The harbour figure was wrong before the recount.",
    body: `First tally from memory, week one on the island. Superseded by [[crew/fleet-strength]] after the recount, ship by ship: the harbour was 484, not 480. Kept so I remember how far memory was off.

| Where | Lost (draft) |
| --- | --- |
| Ismarus | 72 |
| The cave | 6 |
| The harbour | 480 |
| Aeaea | 1 |
| Scylla | 6 |
| Thrinacia | 31 |
| **Total** | **596** |

Four men I could not place. I spent a night on it before I saw it was the harbour: eleven ships of forty-four each, and I had counted one of them at forty.`,
    links: ["crew/fleet-strength.md"],
  },
  {
    path: "notes/sails-seen.md",
    title: "Sails (old count)",
    type: "capture",
    status: "superseded",
    summary: "An early count of sails from the headland, overtaken by the closed count in year five.",
    created: "2023-02-07",
    updated: "2023-12-03",
    tags: ["sails", "headland"],
    body: `Thirty-eight sails since landing, as of today. None closer than the horizon.

Later: this page stopped before the count did. Forty-one when I closed it, in year five ([[ogygia/island/sightings]]).`,
    links: ["ogygia/island/sightings.md"],
  },
  {
    path: "notes/distance-to-scheria.md",
    title: "788 km to Scheria?",
    type: "note",
    created: "2026-07-08",
    updated: "2026-07-09",
    status: "superseded",
    tags: ["crossing", "raft"],
    places: ["place:ogygia", "place:scheria", "place:ithaca"],
    summary: "First pass at the distance, which took the whole way home as the distance to Scheria. Corrected the next day.",
    body: `First pass: 788 km to Scheria in seventeen days, about 46 a day.

Corrected next morning. 788 is the whole way home, Ogygia to Scheria to Ithaca. The open water to Scheria is about 632 km, so about 37 a day; Scheria to Ithaca is about 156 more. Working is in [[studies/crossing-distance-and-margin]]. Directions as she gave them: [[ogygia/build/sailing-directions]].

Leaving this up because I nearly provisioned for the easier number.`,
    links: ["studies/crossing-distance-and-margin.md", "ogygia/build/sailing-directions.md"],
  },
  // Captures and short notes.
  {
    path: "notes/the-dogs-name.md",
    title: "Argos",
    type: "capture",
    created: "2024-07-04",
    updated: "2024-07-04",
    tags: [],
    body: `Said his name out loud on the headland this morning so it would still be in my mouth when I need it. [[people/argos|Argos]].`,
    links: ["people/argos.md"],
  },
  {
    path: "notes/eurylochus-three-times.md",
    title: "Eurylochus, three times",
    type: "note",
    status: "recorded",
    summary: "Three recorded disagreements with Eurylochus, on days 99, 248 and 1,044, and who was right about what.",
    created: "2019-08-02",
    updated: "2019-08-02",
    tags: ["Crew"],
    people: ["person:eurylochus"],
    body: `[[Eurylochus]] argued with me out loud three times that I wrote down: day 99, day 248 and day 1,044 ([[crew/dissent-log]]).

On day 248 he would not go back to Circe's house and called me reckless for the cave. On day 1,044 he said the crew could not row another night and we should land. He was right about the cave. He was right that they could not row. He was wrong about what to do with either.

I nearly killed him on day 248. I am glad I did not. [[eurylochus]] led them to the cattle; I still do not wish I had.`,
    links: ["crew/dissent-log.md"],
  },
  {
    path: "notes/things-calypso-said.md",
    title: "things she said",
    type: "capture",
    created: "2026-07-07",
    updated: "2026-07-11",
    tags: ["calypso", "quotes"],
    people: ["person:calypso"],
    body: `[[calypso]], day 3,647, on the headland: "Do not weep here any longer. I will send you off willingly."

Same night: "Did you think I would harm you, after seven years?" I made her swear anyway.

Day 3,651, handing over the cloth: nothing. She just held it out.`,
    links: ["people/calypso.md", "oaths/calypso-no-harm.md"],
  },
  {
    path: "notes/to-ask-eumaeus.md",
    title: "to ask Eumaeus",
    type: "capture",
    created: "2026-06-24",
    updated: "2026-06-24",
    tags: ["ithaka", "todo"],
    body: `Is the dog alive. Who kept the swine count honest. Does my father still come down to the town. [[people/eumaeus]]`,
    links: ["people/eumaeus.md"],
  },
  {
    path: "notes/raft-todo-old.md",
    title: "raft todo",
    type: "capture",
    created: "2026-07-08",
    updated: "2026-07-09",
    tags: ["todo", "raft"],
    body: `- [x] twenty trees down
- [ ] square and peg
- [ ] ask her for cloth
- [ ] second skin of wine?
- [ ] water — more than one skin

Moved to [[ogygia/build/departure-checklist]] and [[ogygia/build/plan]]. This one is stale.`,
    links: ["ogygia/build/departure-checklist.md", "ogygia/build/plan.md"],
  },
  {
    path: "notes/winds-i-have-had.md",
    title: "Every wind I have had",
    type: "note",
    status: "recorded",
    created: "2026-07-12",
    updated: "2026-07-12",
    tags: ["winds", "weather"],
    places: ["place:malea", "place:aeolia", "place:thrinacia", "place:ogygia"],
    summary: "The four winds and what each has done to me, written at first light on the morning of the launch.",
    body: `Written at first light, the air off the land ([[omens/day-3652-dawn-wind]]).

- **North.** Took us off Malea and nine days south ([[omens/day-21-malea-wind]], [[knowledge/boreas]]).
- **All of them at once.** Out of the bag, off Ithaca ([[crew/aeolia-bag]]).
- **South and east.** Thirty days on Thrinacia, holding us there until the stores ran out ([[knowledge/notus]], [[knowledge/eurus]]).
- **West.** The one Aeolus left loose to take us home ([[knowledge/zephyrus]]). It did.

Today's wind is from astern of the heading. I have been given a good wind before.`,
    links: [
      "omens/day-3652-dawn-wind.md",
      "omens/day-21-malea-wind.md",
      "knowledge/boreas.md",
      "crew/aeolia-bag.md",
      "knowledge/notus.md",
      "knowledge/eurus.md",
      "knowledge/zephyrus.md",
    ],
  },
  {
    path: "notes/hosts-compared.md",
    title: "Hosts, compared",
    type: "note",
    status: "recorded",
    created: "2021-03-08",
    updated: "2026-07-07",
    tags: ["xenia", "hosts"],
    people: ["person:polyphemus", "person:circe", "person:calypso"],
    places: ["place:cyclopes", "place:aeolia", "place:aeaea", "place:ogygia"],
    summary: "Four hosts, two oaths, one refusal.",
    body: `| Host | Welcome | Oath | How it ended |
| --- | --- | --- | --- |
| Polyphemus | none | refused guest-right | blinded |
| Aeolus | a month | guest-friendship | withdrawn |
| Circe | drugs, then a year | sworn after [[moly]] ([[oaths/circe-no-harm]]) | gave the route |
| Calypso | seven years | sworn day 3,647 ([[oaths/calypso-no-harm]]) | gave the timber |

Both goddesses swore only because I asked, and both kept it. The men never did.

General rules: [[knowledge/guest-friendship]].`,
    links: ["oaths/circe-no-harm.md", "oaths/calypso-no-harm.md", "knowledge/guest-friendship.md", "decisions/go-to-circe-alone.md"],
  },
  {
    path: "notes/the-dead-i-still-say.md",
    title: "Names I still say",
    type: "note",
    status: "recorded",
    summary: "The names I say on the way up the headland, and the hundreds I cannot.",
    created: "2020-02-02",
    updated: "2026-06-24",
    tags: ["crew", "the-dead"],
    people: ["person:elpenor"],
    body: `Most nights, on the way up or down the headland, not in order:

Polites. Antiphus. Elpenor. Perimedes, who added rope when I begged. My mother. Achilles, who would rather be a hired hand above ground.

Four hundred and eighty-four I cannot say one by one, because I never knew all of them. That is its own entry somewhere. [[crew/polites]], [[crew/antiphus]], [[elpenor]], [[crew/perimedes]].`,
    links: ["crew/polites.md", "crew/antiphus.md", "crew/perimedes.md", "people/achilles.md"],
  },
  {
    path: "notes/headland-nights.md",
    title: "nights on the headland",
    type: "capture",
    created: "2020-02-02",
    updated: "2020-02-02",
    tags: ["headland"],
    body: `Third night running up on the [[headland]] instead of asleep. Learning the sky, I tell myself ([[journal/day-1300]]).`,
    links: ["journal/day-1300.md"],
  },
  // Orphans: nothing in, nothing out.
  {
    path: "notes/stray-pitch.md",
    title: "pitch",
    type: "capture",
    created: "2026-07-09",
    updated: "2026-07-09",
    tags: [],
    body: `The smell of pine pitch on my hands tonight, and for a moment I was on a beach I could not name.`,
    links: [],
  },
  {
    path: "notes/lists/check-at-first-light.md",
    title: "Check at first light",
    type: "list",
    created: "2026-07-10",
    updated: "2026-07-10",
    tags: ["todo"],
    body: `- knots
- stopper in the water skin
- the count
- which way the smoke goes
- the knife
- where the Bear went down`,
    links: [],
  },
  {
    path: "notes/eleven-or-twelve.md",
    title: "eleven or twelve",
    type: "capture",
    created: "2017-02-04",
    updated: "2017-02-04",
    tags: [],
    body: `Eleven or twelve. Ask again in the morning. Do not write it down anywhere else until it is certain.`,
    links: [],
  },
];

export const notesKnownIssues: KnownIssues = {
  unresolved: [
    ["notes/threads/names.md", "notes/lists/names-of-the-dead.md"],
    ["notes/threads/wine.md", "knowledge/wine-of-maron.md"],
    ["notes/threads/gifts-given-and-owed.md", "people/iphitus.md"],
    ["notes/threads/fathers-and-sons.md", "notes/threads/telemachus-and-me.md"],
    ["notes/threads/signs-i-ignored.md", "omens/day-1062-the-gulls.md"],
    ["notes/threads/unrecognised.md", "notes/threads/disguise.md"],
    ["notes/threads/islands.md", "notes/threads/islands-part-2.md"],
    ["notes/threads/doors.md", "knowledge/doors-and-thresholds.md"],
  ],
  orphans: ["notes/stray-pitch.md", "notes/lists/check-at-first-light.md", "notes/eleven-or-twelve.md"],
};
