// Library domain: knowledge. See ../README.md and ./types.ts.
//
// What the voyage learned, entry by entry: hazards and peoples, the gods as
// they bear on a sailor, winds, stars and seamanship. Each knowledge record
// says who told it, whether it proved true and what it means for the
// crossing. The studies are the longer working-out, done on Ogygia.

import type { LibraryDocument } from "./types.js";

const knowledge: LibraryDocument[] = [
  {
    path: "knowledge/lotus.md",
    title: "The lotus",
    type: "knowledge",
    created: "2016-08-11",
    updated: "2026-07-10",
    status: "settled",
    tags: ["hazard", "peoples", "crew"],
    places: ["place:lotus"],
    summary: "A food that takes away the wish to go home. The people who offer it mean no harm, which is what makes it dangerous.",
    body: `Landed on day 30 ([[voyage/day-30-lotus-eaters]]), after nine days driven from Cape Malea. Sent three men inland ([[crew/lotus-eaters]]) to learn who lived there. They did not come back by evening.

## What was found

- The Lotus-eaters offered no violence. They offered the fruit, as a host offers bread.
- The three who ate it no longer wanted anything: not the ship, not news, not home. They wept when they were taken away.
- I had them dragged to the ships and tied under the benches ([[decisions/drag-back-the-lotus-eaters]]). Then we left at once, before anyone else tasted it.

## Source and standing

| | |
|---|---|
| Source | Own observation |
| Proved | Yes, on three men |
| Losses | None |

## For the crossing

There is no lotus on the raft. The entry stays because the lesson is general: the most dangerous offer is the one made kindly by someone who wants nothing back, and the remedy is to leave before deciding whether to stay. Seven years on [[ogygia/_index]] is the same lesson at a larger scale, and I have not filed it as a lesson until this week.

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "ogygia/_index.md", "voyage/day-30-lotus-eaters.md", "crew/lotus-eaters.md", "decisions/drag-back-the-lotus-eaters.md"],
    fields: { day: 30, source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/cyclopes-customs.md",
    title: "The Cyclopes' customs",
    type: "knowledge",
    created: "2016-10-19",
    updated: "2019-07-20",
    status: "settled",
    tags: ["peoples", "hazard", "guest-friendship"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes"],
    summary: "No assemblies, no laws, no ships and no regard for Zeus. Guest-right does not hold there, and I went in expecting it.",
    body: `Written up on day 99, the evening we got clear, from what we saw in four days.

## How they live

- **No assembly and no law.** Each one rules his own wives and children and has no care for his neighbour.
- **No farming.** Wheat, barley and vines grow unsown; they leave it to the gods.
- **No ships and no shipwrights.** The island offshore has a good harbour, wild goats and no people, because none of them can cross a strait to settle it.
- **Herds kept in caves**, closed with a stone.

## What I got wrong

I went into the cave of [[people/polyphemus]] with twelve men ([[crew/cave-party]]) and the strong wine from Maron, to see whether he would give guest-gifts. The crew wanted to take cheese and kids and go. I wanted the gift ([[decisions/wait-for-polyphemus]]). He asked where our ship was moored, and I lied, which was the one thing done right. He did not fear Zeus, guardian of strangers, and said so: [[oaths/xenia-polyphemus]]. He ate six men over the stay.

## Standing

| Claim | Proved |
|---|---|
| They keep no law | Yes |
| Guest-right is observed | No |
| The one we met is a son of Poseidon | Yes, by his own prayer ([[oaths/polyphemus-curse]]) |

## For the crossing

The grievance of [[people/poseidon]] begins here, and the sea between here and home is his. See [[decisions/name-at-the-stern]] for the part that made it personal, and [[notes/do-not-give-my-name]] for the instruction I wrote and then broke.

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/polyphemus.md", "people/poseidon.md", "decisions/name-at-the-stern.md", "notes/do-not-give-my-name.md", "crew/cave-party.md", "decisions/wait-for-polyphemus.md", "oaths/xenia-polyphemus.md", "oaths/polyphemus-curse.md"],
    fields: { day: 99, source: "own observation", proved: "partly", cost: "6 men" },
  },
  {
    path: "knowledge/cyclops-door-stone.md",
    title: "The stone across the cave",
    type: "knowledge",
    created: "2016-10-17",
    updated: "2016-10-19",
    status: "settled",
    tags: ["hazard", "peoples"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Twenty-two good wagons could not have shifted it. Killing him while he slept would have shut us in for good.",
    body: `Day 97 ([[journal/day-97]]). Noted the evening after the first two men were taken, so that I would not act on anger.

The stone he sets in the cave mouth each night is beyond any number of us to move. I measured it by eye against a wagon: more than twenty wagons' weight. My first thought was the sword, under his ribs, while he slept. The second thought was the stone. If he dies, the door stays shut and we die in the dark beside him.

## What followed from it

1. He must live, and he must open the door himself.
2. He must not be able to see who goes out.
3. Nobody outside must come when he calls for help.

The olive stake, hardened in the fire, settled the second ([[decisions/blind-rather-than-kill]]). The name settled the third ([[decisions/nobody-as-the-name]]). The rams settled the first: each man tied under the bellies of three, and I under the largest ([[voyage/day-99-escape]]).

## Standing

Proved. Every one of us who was alive that morning walked out.

## For the crossing

The general rule: before acting on the obvious move, ask what it locks behind you. I applied it on day 97 and forgot it on day 99, at the stern, where the obvious move was to shout. See [[decisions/name-at-the-stern]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "decisions/name-at-the-stern.md", "journal/day-97.md", "decisions/blind-rather-than-kill.md", "decisions/nobody-as-the-name.md", "voyage/day-99-escape.md"],
    fields: { day: 97, source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/laestrygonians.md",
    title: "The Laestrygonians",
    type: "knowledge",
    created: "2017-02-02",
    updated: "2026-07-10",
    status: "settled",
    tags: ["peoples", "hazard", "harbours"],
    places: ["place:laestrygonians"],
    summary: "A harbour with cliffs on both sides and a narrow mouth, and a people who hunt men from the clifftops. Eleven ships lost in it; one moored outside.",
    body: `Day 205. The worst entry in this brain, by count.

## What happened

The harbour is closed by high rock on both sides, with a narrow entrance and no swell inside. The eleven other ships went in and moored close together. I kept ship 1 outside ([[decisions/moor-outside-the-harbour]]), tied to a rock at the edge, for no reason I could have defended at the time.

Three men went inland. They met the king's daughter at a spring, and she showed them to her father's house ([[people/antiphates]]). He seized one of them for his meal. Then the people came to the cliff tops, more than could be counted, and threw rocks down on the ships, and speared the men like fish.

I cut the cable with my sword and we rowed ([[decisions/cut-the-cable]]).

| Ships in the harbour | 11 |
|---|---|
| Lost | 484 men, every one of their crews, the scout taken in the hall among them |
| Ship 1, outside | 38 aboard, all escaped |

## Standing

Source: own observation. Proved, beyond any wish for it not to be.

## For the crossing

A raft cannot row out of anything, so the rule is stricter now: **do not enter an enclosed harbour on an unknown coast**. Lie off, or beach on open shore where the way out is the same as the way in. See [[knowledge/reading-a-coast]] and the count in [[crew/losses/laestrygonians]] and [[crew/_index]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "knowledge/reading-a-coast.md", "crew/_index.md", "decisions/moor-outside-the-harbour.md", "people/antiphates.md", "decisions/cut-the-cable.md", "crew/losses/laestrygonians.md"],
    fields: { day: 205, source: "own observation", proved: "yes", cost: "484 men" },
  },
  {
    path: "knowledge/wandering-rocks.md",
    title: "The Wandering Rocks",
    type: "knowledge",
    created: "2019-05-16",
    updated: "2019-05-21",
    status: "untested",
    tags: ["hazard", "route"],
    people: ["person:circe"],
    summary: "The blessed gods call them the Clashing Rocks. Only one ship ever passed them, and it had Hera's help. Circe offered them as the other road; I did not take it.",
    body: `Told by [[people/circe]] on day 1038 ([[voyage/day-1038-circes-route]]), as one of two roads past the Sirens.

> On one side, beetling rocks, and the great wave of Amphitrite roars against them. No bird gets past them, not even the doves that carry ambrosia to Father Zeus; the smooth rock always takes one of them, and the Father sends another to make up the number.

## What she said

- No ship of men has come through them except one, the Argo, on its way home from Aeetes, and that only because Hera loved Jason.
- The surge carries timbers and bodies together, with storms of fire.
- She would not tell me which road to choose. She said I must decide.

## Standing

| Claim | Status |
|---|---|
| The rocks exist and move | Untested. I did not go near them. |
| Only the Argo has passed | Reported, by Circe |

I chose the strait ([[voyage/legs/the-strait]]) instead. See [[decisions/scylla-or-charybdis]] and [[studies/strait-passages-compared]].

## For the crossing

None, as far as I can tell. The rocks lie on the road to the strait, and the crossing to Scheria runs nowhere near it. Kept because an untested hazard is still a hazard, and because the doves that do not get through are the most exact thing anyone has told me about how the gods keep count.

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/circe.md", "decisions/scylla-or-charybdis.md", "studies/strait-passages-compared.md", "voyage/day-1038-circes-route.md", "voyage/legs/the-strait.md"],
    fields: { day: 1038, source: "Circe", proved: "untested" },
  },
  {
    path: "knowledge/thrinacia-cattle.md",
    title: "The cattle of Helios",
    type: "knowledge",
    created: "2018-03-24",
    updated: "2019-07-12",
    status: "settled",
    tags: ["hazard", "gods", "crew"],
    people: ["person:teiresias", "person:circe", "person:eurylochus"],
    places: ["place:thrinacia"],
    summary: "Seven herds of fifty, and as many flocks. They are never born and they never die. Warned twice, sworn once, killed on day 1077.",
    body: `## What was told

| Source | Day | Said |
|---|---|---|
| [[people/teiresias]] | 620 | Leave them unharmed and you may yet reach Ithaca. Harm them and I foresee ruin for ship and crew. |
| [[people/circe]] | 1038 | Seven herds of cattle and seven flocks of sheep, fifty to each. They bear no young and never die. Two nymphs tend them, daughters of the Sun. |

Three hundred and fifty head of cattle, and as many sheep, and the number never changes. Nobody could take one unnoticed, because there is nothing to hide it among: the count is the herd.

## What happened

We landed on day 1044 because the crew would not row on ([[decisions/land-on-thrinacia]]). I made them swear: [[oaths/helios]]. The wind went into the south and east and stayed there about thirty days. The ship's stores ran out; the men fished and hunted birds. On day 1077 ([[voyage/day-1077-the-cattle]]) I went inland to pray, fell asleep, and [[crew/eurylochus]] persuaded the rest. Six days of feasting. On day 1084 we sailed, and Zeus broke the ship within the day ([[voyage/day-1084-the-storm]]).

## Standing

Proved in every clause. 31 lost: every man still alive. See [[crew/losses/thrinacia]].

## For the crossing

There are no herds on the raft. What carries forward is in [[knowledge/teiresias-forecast]] and [[decisions/cattle-of-helios]]: the condition was broken, so the rest of the forecast runs in its harsher form.

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/teiresias.md", "people/circe.md", "oaths/helios.md", "crew/eurylochus.md", "knowledge/teiresias-forecast.md", "decisions/cattle-of-helios.md", "decisions/land-on-thrinacia.md", "voyage/day-1077-the-cattle.md", "voyage/day-1084-the-storm.md", "crew/losses/thrinacia.md"],
    fields: { source: "Teiresias; Circe", proved: "yes", cost: "31 men" },
  },
  {
    path: "knowledge/circe-drugs.md",
    title: "Circe's drugs",
    type: "knowledge",
    created: "2017-03-16",
    updated: "2018-03-15",
    status: "settled",
    tags: ["hazard", "gods", "medicine"],
    people: ["person:circe", "person:eurylochus"],
    places: ["place:aeaea"],
    summary: "Cheese, barley meal and honey in Pramnian wine, with a drug stirred in. Then the wand. The men kept their minds inside the shape.",
    body: `Reported by [[crew/eurylochus]], who stayed outside the door and ran back to the ship on day 247 ([[voyage/day-247-the-swine]]).

## The preparation

- Cheese, barley meal and pale honey, mixed into Pramnian wine.
- A drug added to it, "to make them forget their native land utterly".
- When they had drunk, she struck them with a wand and penned them in the sties.

## The effect

They had the heads, voices, bristles and shape of swine. Their minds stayed as they were. They wept in the sty, and she threw them acorns and cornel fruit.

## The remedy

[[knowledge/moly]], given by [[people/hermes]] on the path up. The drug did nothing to me. When I drew on her as he told me, she knew at once who I was, because Hermes had long ago told her I would come.

She restored them with a second ointment. They came back younger and taller than before.

## Standing

| Claim | Proved |
|---|---|
| The drink transforms | Yes, on the scouting party ([[crew/aeaea-scouting-party]]) |
| Moly protects | Yes, on me |
| She can reverse it | Yes |

## For the crossing

Nothing aboard is hers. Kept as a record of the one case where a hazard was turned into a host by following instructions exactly ([[oaths/circe-no-harm]]), which is the case I am now relying on with [[people/calypso]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/circe.md", "crew/eurylochus.md", "knowledge/moly.md", "people/calypso.md", "voyage/day-247-the-swine.md", "people/hermes.md", "crew/aeaea-scouting-party.md", "oaths/circe-no-harm.md"],
    fields: { day: 247, source: "Eurylochus; own observation", proved: "yes" },
  },
  {
    path: "knowledge/moly.md",
    title: "Moly",
    type: "knowledge",
    created: "2017-03-17",
    updated: "2017-03-17",
    status: "settled",
    tags: ["medicine", "gods"],
    places: ["place:aeaea"],
    summary: "The gods call it moly. Hard for mortal men to dig up; the gods can do anything. Given by Hermes on the path to Circe's house.",
    body: `[[people/hermes]] met me on the path up from the ship on day 248 ([[voyage/day-248-moly]]), in the likeness of a young man with his first beard. He pulled the plant from the ground and showed me its nature.

## Description, as given

- The root is dark; the flower is pale.
- The gods call it moly.
- It is hard for men to dig. He dug it for me.

## Instructions, as given

1. Take it into her house. Her drink will not work on you.
2. When she strikes you with the wand, draw your sword and rush at her as if to kill her.
3. She will ask you to her bed. Do not refuse, but first make her swear the great oath of the gods that she will plot no further harm against you.
4. Otherwise she will unman you once you are stripped.

## Standing

Every step proved ([[decisions/go-to-circe-alone]]). The oath was sworn before anything else happened: [[oaths/circe-no-harm]].

## For the crossing

I asked [[people/calypso]] for the same oath on day 3647 before I would trust the raft, and she swore it: [[oaths/calypso-no-harm]]. The method came from here: a promise first, the help second. See [[knowledge/circe-drugs]].

Filed under [[knowledge/_index]].`,
    links: ["oaths/calypso-no-harm.md", "knowledge/_index.md", "people/calypso.md", "knowledge/circe-drugs.md", "people/hermes.md", "voyage/day-248-moly.md", "decisions/go-to-circe-alone.md", "oaths/circe-no-harm.md"],
    fields: { day: 248, source: "Hermes", proved: "yes" },
  },
  {
    path: "knowledge/rites-for-the-dead.md",
    title: "The rites for the dead",
    type: "knowledge",
    created: "2018-03-15",
    updated: "2018-03-24",
    status: "settled",
    tags: ["rites", "gods", "acheron"],
    people: ["person:circe", "person:teiresias"],
    places: ["place:acheron"],
    summary: "A trench a cubit each way, four pourings, barley, the vows, then the blood. Keep the others back with the sword until Teiresias has drunk.",
    body: `Given by [[people/circe]] on day 611, as the price of the route ([[decisions/go-to-the-dead]]). Carried out on day 620 ([[voyage/day-620-acheron]]).

## The procedure

- [x] Beach where Pyriphlegethon and Cocytus flow into Acheron, at the rock where the two rivers meet.
- [x] Dig a trench a cubit long and a cubit wide.
- [x] Pour to all the dead: first milk and honey, then sweet wine, then water.
- [x] Sprinkle barley meal over it.
- [x] Vow a barren heifer, the best I have, to be burned at Ithaca, with treasure on the pyre.
- [x] Vow to Teiresias alone a ram, the finest in my flocks.
- [x] Cut the throats of the ram and ewe over the trench, turned toward Erebus, and look away toward the river.
- [x] Have the men flay and burn the beasts, and pray to Hades and Persephone.
- [x] Sit with the sword drawn and let none of the shades near the blood until Teiresias has answered.

## Outstanding

- [ ] The heifer, at Ithaca.
- [ ] The ram for Teiresias, at Ithaca.

Both are owed on arrival ([[oaths/vow-to-the-dead]]) and neither can be paid from here. They go on the first page of the list for home: [[ithaca/homecoming-checklist]].

## Standing

Proved. The dead came, and the seer drank and spoke. See [[knowledge/order-of-the-shades]] and [[knowledge/teiresias-forecast]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/circe.md", "knowledge/order-of-the-shades.md", "knowledge/teiresias-forecast.md", "decisions/go-to-the-dead.md", "voyage/day-620-acheron.md", "oaths/vow-to-the-dead.md", "ithaca/homecoming-checklist.md"],
    fields: { day: 620, source: "Circe", proved: "yes", owed: "2 sacrifices at Ithaca" },
  },
  {
    path: "knowledge/order-of-the-shades.md",
    title: "The order of the shades",
    type: "knowledge",
    created: "2018-03-24",
    updated: "2018-03-28",
    status: "settled",
    tags: ["acheron", "rites", "crew"],
    people: ["person:elpenor", "person:teiresias"],
    places: ["place:acheron"],
    summary: "Elpenor first, unburied. Then my mother, whom I had to keep from the blood. Then Teiresias. Then the rest, and Ajax, who would not speak.",
    body: `The order in which they came to the trench on day 620, kept because it was not the order I would have chosen.

| # | Shade | What passed |
|---|---|---|
| 1 | [[crew/elpenor]] | Unburied, so not yet among the dead. Asked to be burned with his armour and his oar set on the barrow. |
| 2 | [[people/anticleia]], my mother | Alive when I left Ithaca. Dead of grief for me. I held her back from the blood with the sword, weeping, because the seer had to drink first. |
| 3 | [[people/teiresias]] | Drank, and gave the forecast. |
| 4 | Anticleia again | Drank, knew me, and gave the news of home: Penelope waiting, Telemachus holding the land, my father on the farm. She could not be held. Three times I tried. |
| 5 | The noble women | One at a time at the blood, as I made them. |
| 6 | [[people/agamemnon]] | Killed at his own table on the day he came home. Advised me to come in secretly. |
| 7 | Achilles | Would rather be a hired man on earth than king of all the dead. |
| 8 | [[people/ajax-son-of-telamon]] | Still angry over the armour. Stood apart and went away into the dark without a word. |

## What is worth keeping

- The dead do not know you until they drink.
- An unburied man comes first, before the seer, before your own mother.
- Agamemnon's advice stands: land unannounced. It is the most practical sentence anyone has said to me about Ithaca.

Elpenor was buried on day 624 as he asked ([[voyage/day-624-elpenor-buried]]). Filed under [[knowledge/_index]]; procedure in [[knowledge/rites-for-the-dead]].`,
    links: ["knowledge/_index.md", "crew/elpenor.md", "people/teiresias.md", "knowledge/rites-for-the-dead.md", "people/anticleia.md", "people/agamemnon.md", "people/ajax-son-of-telamon.md", "voyage/day-624-elpenor-buried.md"],
    fields: { day: 620, source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/guest-friendship.md",
    title: "Guest-friendship",
    type: "knowledge",
    created: "2016-07-20",
    updated: "2026-07-11",
    status: "active",
    tags: ["guest-friendship", "customs"],
    summary: "Feed the stranger before you ask his name. Zeus is the guardian of guests. It held everywhere except where it did not, and those places are the hazards.",
    body: `Learned in my father's hall, not at sea. Written down on the way out from Troy, because the fleet's young men did not all know it.

## The rule, as kept in a decent house

1. A stranger at the door is taken in before anyone asks his business.
2. He is bathed, given a clean cloak, seated and fed.
3. Only after he has eaten is he asked his name, his city and his father.
4. He is given gifts when he goes, and conveyance if it can be managed.
5. The bond passes to the sons of both houses.

## Where it held and where it did not

| Place | Host | Held |
|---|---|---|
| Aeolia | [[people/aeolus]] | Yes, a month, until the second visit ([[oaths/xenia-aeolus]]) |
| Aeaea | Circe | After the oath, yes, for a year and more |
| Ogygia | Calypso | Seven years |
| Land of the Cyclopes | Polyphemus | No ([[oaths/xenia-polyphemus]]) |
| Land of the Laestrygonians | the king, [[people/antiphates]] | No |

The hazards on this voyage are, almost exactly, the places where this rule failed. That is the most useful sentence in this entry.

## For the crossing

At Scheria I arrive as a stranger with nothing. I know nothing of the people there. The rule is all I can count on, and the rule depends on them keeping it. See [[knowledge/suppliants]] for what to do if I cannot be sure, and [[knowledge/guest-gifts]] for what is owed in return.

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "knowledge/suppliants.md", "knowledge/guest-gifts.md", "people/aeolus.md", "oaths/xenia-aeolus.md", "oaths/xenia-polyphemus.md", "people/antiphates.md"],
    fields: { source: "Laertes's household", proved: "partly" },
  },
  {
    path: "knowledge/guest-gifts.md",
    title: "Guest-gifts",
    type: "knowledge",
    created: "2016-11-21",
    updated: "2019-07-20",
    status: "settled",
    tags: ["guest-friendship", "customs"],
    summary: "A gift is a record: who gave, what, and what is owed back. I have received more than I can repay and kept almost none of it.",
    body: `A gift between guest and host is not a payment. It is the written part of the bond, carried in the hands. The ledger below is what I have been given since Troy, and where it is now.

| From | Gift | Where it is |
|---|---|---|
| [[people/maron]], priest of Apollo, at Ismarus | Seven talents of worked gold, a mixing bowl of solid silver and twelve jars of sweet unmixed wine, for sparing him and his household | The wine was used on Polyphemus ([[oaths/maron-guest-gift]]). The rest went down with the ships. |
| Aeolus | An oxhide bag holding every wind except the west | Opened by the crew in sight of Ithaca ([[crew/aeolia-bag]]). |
| Circe | The route, the rites, and provisions | Used. The route held where I followed it. |
| Polyphemus | "Nobody I will eat last" | Kept, in its way. |
| Calypso | The tools, the cloth, the provisions and the wind | On the raft, today. See [[ogygia/debts]]. |

## Customs observed

- A host who gives a gift expects to be named as its giver for as long as it exists.
- A gift is not refused. A gift that cannot be accepted is a quarrel.
- What a guest takes away, he owes back to the host's house when that house visits his.

## For the crossing

I owe Aeolus a return I cannot make; he sent me away as hated by the gods. I owe Circe and Calypso returns that neither of them needs. I will reach Scheria with nothing to give. See [[knowledge/guest-friendship]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "knowledge/guest-friendship.md", "people/maron.md", "oaths/maron-guest-gift.md", "crew/aeolia-bag.md", "ogygia/debts.md"],
    fields: { source: "own records", proved: "yes" },
  },
  {
    path: "knowledge/suppliants.md",
    title: "Supplication",
    type: "knowledge",
    created: "2016-07-20",
    updated: "2026-07-11",
    status: "active",
    tags: ["guest-friendship", "customs", "scheria"],
    places: ["place:scheria"],
    summary: "Clasp the knees, or sit at the hearth in the ashes. Zeus protects suppliants. For use at an unknown landfall, where I will have nothing else.",
    body: `A suppliant is a stranger who has no claim of his own and asks to be given one.

## The forms

- **At the knees.** Kneel, clasp the knees of the one you ask, and do not let go until answered.
- **At the hearth.** Sit in the ashes beside the fire of the house, by the pillar, and wait.
- **By the branch.** Carry a branch wound with wool, where that is the custom.
- **From a distance.** If clasping the knees would give offence, as with a young woman or someone who might fear you, speak from where you stand and say so.

## What it binds

Zeus is the guardian of suppliants as well as of strangers. A house that turns away a suppliant at the hearth answers to him. A house that takes one in gives him the standing of a guest.

## Standing

Reported, by custom. I have used it once, at the knees of [[people/circe]] after the oath ([[oaths/circe-no-harm]]), asking for the men to be restored, and it held.

## For the crossing

Scheria is a planned landfall ([[voyage/legs/ogygia-to-scheria]]) and nothing more. I know nothing about who lives there. If I come ashore with nothing, this is the procedure, and I would rather have it written down than trust myself to remember it after seventeen days alone.

- [ ] Choose which form before landing, by what I see first.

Filed under [[knowledge/_index]]. See [[knowledge/guest-friendship]], and [[people/eupeithes]] for a suppliant once received at my own house.`,
    links: ["knowledge/_index.md", "people/circe.md", "knowledge/guest-friendship.md", "oaths/circe-no-harm.md", "voyage/legs/ogygia-to-scheria.md", "people/eupeithes.md"],
    fields: { source: "custom", proved: "partly" },
  },
  {
    path: "knowledge/sacrifice-procedure.md",
    title: "Sacrifice procedure",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2019-06-24",
    status: "settled",
    tags: ["rites", "gods", "customs"],
    places: ["place:thrinacia"],
    summary: "Barley, the hair from the brow, the stroke, the thighbones in fat, the wine on the flame. On Thrinacia the crew did it with oak leaves and water, which tells you what they knew.",
    body: `The order, as done on the morning the fleet sailed from Troy ([[voyage/day-3-departure]]).

1. Wash the hands. Bring the beast to the altar and scatter barley meal.
2. Pray, then cut hair from its brow and put it in the fire.
3. Strike. The women raise the cry, where there are women.
4. Cut out the thighbones, wrap them in a double fold of fat, and lay raw meat on them.
5. Burn them on split wood, pouring wine on the flame.
6. Taste the inner parts. Cut the rest, spit it and roast it.
7. Eat, and pour the wine to the gods first.

## On Thrinacia

On day 1077 ([[voyage/day-1077-the-cattle]]) the crew killed the best of the cattle and made the offering anyway. There was no barley left, so they used tender oak leaves. There was no wine left, so they poured water. They did every step in its place, with the wrong things in every hand.

The hides crawled ([[omens/day-1078-hides-crawled]]). The meat lowed on the spits, raw and roasted. They ate for six days.

## Standing

The procedure is sound. It does not make a wrong act right, and the gods are not fooled by its shape.

## For the crossing

Nothing to sacrifice aboard. A libation from the wine on launching, and the vows at Ithaca owed from [[knowledge/rites-for-the-dead]] ([[oaths/vow-to-the-dead]]). See [[decisions/cattle-of-helios]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "knowledge/rites-for-the-dead.md", "decisions/cattle-of-helios.md", "voyage/day-3-departure.md", "voyage/day-1077-the-cattle.md", "omens/day-1078-hides-crawled.md", "oaths/vow-to-the-dead.md"],
    fields: { source: "custom; own observation", proved: "yes" },
  },
  {
    path: "knowledge/zeus.md",
    title: "Zeus, as he bears on a sailor",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-07",
    status: "active",
    tags: ["gods", "weather"],
    summary: "Guardian of strangers and suppliants, gatherer of clouds, holder of the thunderbolt. He broke the ship on Thrinacia and ordered the raft on Ogygia.",
    body: `## His domains, as they bear on the crossing

| Domain | Effect at sea |
|---|---|
| Sky, cloud, thunder | Storms; the thunderbolt that broke the ship on day 1084 |
| Strangers and suppliants | Whether I am taken in at a landfall |
| Oaths | Whether a sworn word holds |
| Final say among the gods | Whether the others may act against me |

## What he has done

- Day 1084: answered [[people/helios]]. A storm from the west, the mast down across the steersman, the thunderbolt into the ship ([[omens/day-1084-thunder]]). Every man went into the sea.
- Day 3647 ([[ogygia/build/day-3647-the-order]]): sent Hermes to [[people/calypso]] with the order to let me go. She said it was the gods' jealousy; she obeyed, and the same day swore not to harm me: [[oaths/calypso-no-harm]].

## Standing

His order is the reason I am sailing at all. It is not a promise of a safe passage. Hermes brought an order to release me, not an order to the sea.

## For the crossing

Of all the gods his is the one whose favour I can least read. [[people/athena]] I understand; [[people/poseidon]] I understand too well. I will pour to him first at the launch, because he is the one who decided.

Filed under [[knowledge/_index]]. See [[knowledge/hermes]] and [[people/zeus]].`,
    links: ["oaths/calypso-no-harm.md", "knowledge/_index.md", "people/calypso.md", "people/athena.md", "people/poseidon.md", "knowledge/hermes.md", "people/helios.md", "omens/day-1084-thunder.md", "ogygia/build/day-3647-the-order.md", "people/zeus.md"],
    fields: { source: "custom; own observation", proved: "yes" },
  },
  {
    path: "knowledge/poseidon-at-sea.md",
    title: "Poseidon, as he bears on a sailor",
    type: "knowledge",
    created: "2016-10-19",
    updated: "2026-07-11",
    status: "active",
    tags: ["gods", "hazard", "weather"],
    people: ["person:poseidon", "person:polyphemus", "person:teiresias"],
    summary: "Earth-shaker, lord of the sea, father of the Cyclops I blinded. He does not kill me; he keeps me from home. The crossing is entirely in his water.",
    body: `## What he holds

- The sea, all of it. Waves, currents, storms raised with the trident.
- Earthquakes.
- Horses, which does not matter here.

## The grievance

Begun on day 99 ([[voyage/day-99-escape]]), when [[people/polyphemus]] prayed to his father ([[oaths/polyphemus-curse]]) with my name ([[decisions/name-at-the-stern]]) and my father's name and my island in the prayer. He asked that I never reach home; or if I must, that I come late, in bad case, with all my comrades lost, in another's ship, and find trouble in my house.

[[people/teiresias]] said the same on day 620, as a forecast and not as a curse, which is worse.

## Standing

| Claim | Status |
|---|---|
| He holds the grievance | Proved every year since |
| He will not kill me outright | Reported. He has not, so far. |
| Where he is today | Unknown |

## For the crossing

Seventeen days of open water ([[voyage/legs/ogygia-to-scheria]]) in a craft I built myself. If he sees me, nothing in this brain will help. The only practical measures are to go now, while the wind is with me, and to keep the raft simple enough to hold together in a sea it was not built for. See [[studies/poseidon-risk]] and [[people/poseidon]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/polyphemus.md", "people/teiresias.md", "studies/poseidon-risk.md", "people/poseidon.md", "voyage/day-99-escape.md", "oaths/polyphemus-curse.md", "decisions/name-at-the-stern.md", "voyage/legs/ogygia-to-scheria.md"],
    fields: { source: "Polyphemus's prayer; Teiresias", proved: "yes" },
  },
  {
    path: "knowledge/helios.md",
    title: "Helios, as he bears on a sailor",
    type: "knowledge",
    created: "2018-03-24",
    updated: "2019-07-12",
    status: "settled",
    tags: ["gods", "hazard"],
    places: ["place:thrinacia"],
    summary: "Sees everything and hears everything. Owns the herds on Thrinacia. Threatened to go down and shine among the dead if he was not paid for them.",
    body: `## What he holds

The sun, and with it the hours of the day. Everything done under the open sky is done in his sight. The herds on Thrinacia, tended by his daughters Phaethusa and [[people/lampetie]].

## What I was told

- By [[people/teiresias]]: he oversees all things and hears all things.
- Later, from the island where I now am, I learned what passed on Olympos: Lampetie went to him; he went to Zeus and said that if he did not have recompense for his cattle, he would go down into the house of Hades and shine among the dead.

That second report reached me through [[people/calypso]], who had it from Hermes. I have marked it "reported, second-hand".

## Standing

| Claim | Status |
|---|---|
| He sees everything | Proved. Nothing was hidden. |
| He would take it to Zeus | Proved by what followed |
| The threat to shine among the dead | Reported |

## For the crossing

Nothing more is owed him that I can pay. But he still sees: I will sail by day in his sight and by night under the stars, and I will take nothing from any shore that is not offered. See [[knowledge/thrinacia-cattle]], [[oaths/helios]] and [[decisions/cattle-of-helios]].

Filed under [[knowledge/_index]]. Contact record: [[people/helios]].`,
    links: ["knowledge/_index.md", "people/teiresias.md", "people/calypso.md", "knowledge/thrinacia-cattle.md", "oaths/helios.md", "people/lampetie.md", "decisions/cattle-of-helios.md", "people/helios.md"],
    fields: { source: "Teiresias; Calypso, from Hermes", proved: "yes" },
  },
  {
    path: "knowledge/athena-favour.md",
    title: "Athena's favour",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "open",
    tags: ["gods"],
    people: ["person:athena", "person:poseidon"],
    summary: "Stood beside me openly at Troy. Has not shown herself once since the fleet sailed. I have assumed this is deference to her uncle, not a change of mind.",
    body: `## What she gave at Troy

Counsel, in plain sight; and once a sign in the dark ([[omens/heron-in-the-dark]]). She stood beside me in the assembly and in the field, and everyone who saw it knew it.

## Since

Nothing I could point to. Not at the Cyclopes, not at the harbour where eleven ships went down, not in the strait, not in seven years on this beach ([[journal/day-3641]]).

## What I think the reason is

[[people/poseidon]] is her father's brother, and the grievance is his. A god does not openly undo another god's anger. That is my reading, and it is only mine; nobody has told me so.

| Claim | Status |
|---|---|
| She favoured me at Troy | Proved |
| She still does | Unknown |
| Her absence is deference, not anger | My inference only |

## For the crossing

Hermes came to [[people/calypso]] on day 3647 with an order from Zeus ([[ogygia/build/day-3647-the-order]]). Someone asked for that order. I would like it to have been [[people/athena]], and I have not written it down as fact. If she shows herself again, it will be after the sea, not on it.

Filed under [[knowledge/_index]]. See [[omens/day-3646-hawk]], logged the day before Hermes came.`,
    links: ["knowledge/_index.md", "people/poseidon.md", "people/calypso.md", "people/athena.md", "omens/day-3646-hawk.md", "omens/heron-in-the-dark.md", "journal/day-3641.md", "ogygia/build/day-3647-the-order.md"],
    fields: { source: "own observation; inference", proved: "open" },
  },
  {
    path: "knowledge/hermes.md",
    title: "Hermes",
    type: "knowledge",
    created: "2017-03-15",
    updated: "2026-07-07",
    status: "settled",
    tags: ["gods"],
    people: ["person:calypso", "person:circe"],
    summary: "Messenger of Zeus and guide of the dead. Gave me moly on Aeaea, and brought the order that ends the stay on Ogygia. Twice now he has arrived just before a door opened.",
    body: `## His domains, as they bear on me

- Messages from Zeus.
- Guide of souls to the house of Hades.
- Roads, crossings and the luck of travellers.
- Knowledge of plants and their powers.

## Appearances

| Day | Where | What |
|---|---|---|
| 248 | The path up to Circe's house | Moly, and exact instructions. See [[knowledge/moly]] and [[voyage/day-248-moly]]. |
| 3647 | Calypso's cave ([[ogygia/build/day-3647-the-order]]) | Zeus's order to let me go. I did not see him; [[people/calypso]] told me after, and swore [[oaths/calypso-no-harm]]. |

On Aeaea he also said that he had told [[people/circe]] long before that a man named Odysseus would come to her on his way from Troy. So he knew the route before I did.

## Standing

Every instruction he has given has proved true. He has never told me how anything ends.

## For the crossing

He came; the door opened. That is the pattern, twice. It says nothing about what is on the other side of the door. See [[knowledge/zeus]].

Filed under [[knowledge/_index]]. Contact record: [[people/hermes]].`,
    links: ["oaths/calypso-no-harm.md", "knowledge/_index.md", "knowledge/moly.md", "people/calypso.md", "people/circe.md", "knowledge/zeus.md", "voyage/day-248-moly.md", "ogygia/build/day-3647-the-order.md", "people/hermes.md"],
    fields: { source: "own observation; Calypso", proved: "yes" },
  },
  {
    path: "knowledge/aeolus.md",
    title: "Aeolus, keeper of the winds",
    type: "knowledge",
    created: "2016-11-21",
    updated: "2016-12-31",
    status: "settled",
    tags: ["gods", "winds"],
    places: ["place:aeolia"],
    summary: "Zeus made him steward of the winds. He bound all of them in a bag except the west, and gave it to me. The second time, he would not open the door.",
    body: `Aeolia is a floating island with a wall of bronze and sheer cliffs. [[people/aeolus]] lives there with his six sons and six daughters, married to each other, feasting every day.

## The visit

- Guests for a month, from day 132. He asked for the whole story of Troy and I told it.
- On leaving, he gave me an oxhide bag ([[crew/aeolia-bag]]), tied with a silver cord, holding every wind. He let the west wind out to carry us home.
- Nine days and nights of steady sailing. On day 171 we saw the fires on Ithaca. I had held the sheet myself the whole way. I slept ([[decisions/keep-the-helm-nine-days]]).
- The crew thought the bag held gold, and opened it. The winds took us back.

## The second visit

Day 172 ([[voyage/day-172-aeolus-refuses]]). I sat at his door. He said that a man so hated by the gods could not be helped, and sent me away.

## Standing

| Claim | Proved |
|---|---|
| He controls the winds | Yes |
| The west wind alone will carry a ship home from Aeolia | Yes, nine days of it |
| He helps once | Yes |

## For the crossing

There is no bag this time, only whatever wind Calypso can ask for. Two lessons: do not sleep at the sheet within sight of land, and tell the crew what the cargo is. The second no longer applies. The first applies more than ever: see [[studies/sleep-on-a-single-hand-crossing]] and [[knowledge/zephyrus]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "studies/sleep-on-a-single-hand-crossing.md", "knowledge/zephyrus.md", "people/aeolus.md", "crew/aeolia-bag.md", "decisions/keep-the-helm-nine-days.md", "voyage/day-172-aeolus-refuses.md"],
    fields: { day: 132, source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/boreas.md",
    title: "Boreas, the north wind",
    type: "knowledge",
    created: "2016-08-02",
    updated: "2026-07-10",
    status: "active",
    tags: ["winds", "weather"],
    places: ["place:malea"],
    summary: "Born in the clear sky, cold and strong. Drove the fleet off Cape Malea for nine days. On the crossing it would be on the left bow, which a raft cannot hold against.",
    body: `## What it is

The north wind. Clear weather, cold, hard, and steady once it sets in. It rolls up a heavy sea from the north.

## Where it has cost me

Day 21, rounding Cape Malea ([[voyage/legs/cape-malea]]), with Ithaca three days away. The current, the swell and Boreas together drove us past Cythera ([[omens/day-21-malea-wind]]). Nine days later we came ashore among the Lotus-eaters. Everything since begins with that wind.

## Standing

| Claim | Status |
|---|---|
| It brings clear sky | Proved, many times |
| It blows for days once set | Proved at Malea |
| Common in summer on this sea | Observed from Ogygia, seven summers. See [[studies/july-weather]] and [[ogygia/weather/seasons]]. |

## For the crossing

The heading is east of north. Boreas comes from ahead and to the left. A ship can row into it; a raft cannot. If it sets in, the raft goes south and west, back towards where it came from.

- Do not launch into a northerly.
- If one sets in at sea, run off before it and lose the distance, rather than broach.

See [[studies/wind-for-the-heading]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "studies/july-weather.md", "studies/wind-for-the-heading.md", "voyage/legs/cape-malea.md", "omens/day-21-malea-wind.md", "ogygia/weather/seasons.md"],
    fields: { day: 21, source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/notus.md",
    title: "Notus, the south wind",
    type: "knowledge",
    created: "2019-06-24",
    updated: "2026-07-10",
    status: "active",
    tags: ["winds", "weather"],
    places: ["place:thrinacia", "place:charybdis"],
    summary: "Warm and wet, with haze. Blew for a month on Thrinacia with only Eurus for relief, and carried me back to Charybdis after the wreck.",
    body: `## What it is

The south wind. Warm, damp, brings haze and cloud and, in its season, rain. It thickens the horizon so that land is hard to see.

## Where it has cost me

- **Thrinacia, from day 1044.** For a whole month it blew ([[voyage/day-1050-wind-still-south]]), with no other wind but Eurus. We could not sail north to the strait against it. The stores ran out ([[voyage/day-1062-stores-out]]). This is the wind behind [[decisions/cattle-of-helios]].
- **Day 1085** ([[voyage/day-1085-the-fig-tree]]). After the wreck, the west wind dropped and Notus came, and carried me through the night back to Charybdis. I held to the fig tree ([[decisions/hold-the-fig-tree]]) above the whirlpool until the keel and the mast came back up. See [[knowledge/charybdis]].

## Standing

| Claim | Status |
|---|---|
| It can blow for weeks | Proved, thirty days |
| It brings haze | Proved |
| Rare in high summer here | Observed, seven summers. See [[studies/july-weather]]. |

## For the crossing

Notus would be on the right quarter of a raft heading east of north, which is sailable. The danger is the haze: seventeen days without a sight of land, and then a landfall hidden in it. If it comes, slow down near the end and look harder. See [[studies/signs-of-land]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "decisions/cattle-of-helios.md", "knowledge/charybdis.md", "studies/july-weather.md", "studies/signs-of-land.md", "voyage/day-1050-wind-still-south.md", "voyage/day-1062-stores-out.md", "voyage/day-1085-the-fig-tree.md", "decisions/hold-the-fig-tree.md"],
    fields: { source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/eurus.md",
    title: "Eurus, the east wind",
    type: "knowledge",
    created: "2019-06-24",
    updated: "2026-07-10",
    status: "active",
    tags: ["winds", "weather"],
    places: ["place:thrinacia"],
    summary: "The east wind. Kept Notus company for a month on Thrinacia. For the crossing it is a headwind on the right bow and the worst of the four to meet.",
    body: `## What it is

The east wind. Less common than the others in summer on this sea, but persistent when it comes, and gusty off a high coast.

## Where it has cost me

Thrinacia, from day 1044. It took turns with Notus for thirty days. Between the two of them there was no wind that would carry a ship north to the strait or east towards home. The oath was sworn on day 1044 ([[voyage/day-1044-thrinacia-landfall]]); by the end of that month it was a question of hunger ([[crew/thrinacia-provisions]]), and hunger won. See [[oaths/helios]].

## Standing

| Claim | Status |
|---|---|
| It blows with Notus for weeks | Proved on Thrinacia |
| Uncommon in July | Observed from Ogygia. See [[studies/july-weather]]. |

## For the crossing

The heading is east of north. Eurus comes from ahead and to the right, close to dead ahead. Nothing I have built will make way against it.

- If it is blowing on the launch morning, do not launch. See [[ogygia/weather/launch-window]].
- If it sets in at sea, there is nowhere to shelter. Lie to, with the sail down, and wait. Every day of that is a day off the water ration. See [[studies/water-ration]].

Filed under [[knowledge/_index]]. Compare [[knowledge/boreas]].`,
    links: ["knowledge/_index.md", "oaths/helios.md", "studies/july-weather.md", "studies/water-ration.md", "knowledge/boreas.md", "voyage/day-1044-thrinacia-landfall.md", "crew/thrinacia-provisions.md", "ogygia/weather/launch-window.md"],
    fields: { source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/zephyrus.md",
    title: "Zephyrus, the west wind",
    type: "knowledge",
    created: "2016-11-21",
    updated: "2026-07-11",
    status: "active",
    tags: ["winds", "weather"],
    places: ["place:aeolia", "place:thrinacia"],
    summary: "The one wind Aeolus left out of the bag, to blow us home. Also the wind of Zeus's storm on the day we left Thrinacia. For the crossing, the wind I want.",
    body: `## What it is

The west wind. Mild in summer and usually steady. It can also arrive screaming, out of a clear sky, as it did on day 1084.

## Where it has served and cost me

| Day | What it did |
|---|---|
| 162 to 171 | Left out of the bag by Aeolus ([[voyage/day-162-aeolia-departure]]) so that it alone would blow. Nine days, steady, to within sight of Ithaca ([[voyage/legs/ithaca-in-sight]]). |
| 1084 | Came on suddenly after we cleared Thrinacia, with Zeus behind it. The forestays parted, the mast went over the stern and broke the steersman's skull. Then the thunderbolt ([[omens/day-1084-thunder]]). |
| 1085 | Dropped, and gave way to Notus. |

## Standing

Both faces are proved. A fair west wind can carry a ship the whole way home; a west wind sent by a god will break it.

## For the crossing

The heading is east of north. Zephyrus comes from behind and to the left, which is the best a square sail on a raft can ask for. If [[people/calypso]] asks for a wind for me, this is the one.

- [ ] Launch on a westerly or a north-westerly.
- [ ] Reef early if it rises from a clear sky.

See [[studies/wind-for-the-heading]] and [[knowledge/aeolus]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/calypso.md", "studies/wind-for-the-heading.md", "knowledge/aeolus.md", "voyage/day-162-aeolia-departure.md", "voyage/legs/ithaca-in-sight.md", "omens/day-1084-thunder.md"],
    fields: { source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/great-bear.md",
    title: "The Great Bear",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["stars", "navigation"],
    people: ["person:calypso"],
    summary: "Also called the Wain. Turns in one place, watches Orion, and alone of the stars never bathes in Ocean. Calypso's instruction: keep it on the left hand.",
    body: `## What every sailor is told

The Bear, which some call the Wain, turns always in the same place and keeps watch on Orion. Alone of all the stars it has no share in the baths of Ocean: it never sets.

## What I have checked

From Ogygia, seven summers of watching ([[journal/day-3612]] is one such night):

- It turns around a point in the north, nearly two hands' breadth above the sea, measured with the hand held at arm's length.
- At the lowest of its turn, on clear nights, the last star of the tail touches the horizon and is gone for a short while. The rest of the Bear stays up.
- It is never in the south, and never far from north. At its furthest swing it sits a little less than halfway round towards east or west.

So the saying is true of the Bear and very nearly true of its tail. At home, further north, it would be true of every star in it.

## Standing

| Claim | Status |
|---|---|
| It never sets | Proved for the body ([[omens/day-3650-the-bear]]); the tail star dips at this latitude |
| It marks the north | Proved, within its swing |

## For the crossing

[[people/calypso]]'s directions ([[ogygia/build/sailing-directions]]): keep the Bear on the left hand as you sail, and sail east of north. The working-out of how far to the left, at which hour of the night, is in [[studies/steering-by-the-bear]], and the choice of method in [[decisions/sail-by-the-bear]].

Filed under [[knowledge/_index]]. See [[knowledge/orion]].`,
    links: ["knowledge/_index.md", "people/calypso.md", "studies/steering-by-the-bear.md", "knowledge/orion.md", "journal/day-3612.md", "omens/day-3650-the-bear.md", "ogygia/build/sailing-directions.md", "decisions/sail-by-the-bear.md"],
    fields: { source: "sailors' lore; own observation; Calypso", proved: "yes" },
  },
  {
    path: "knowledge/pleiades.md",
    title: "The Pleiades",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["stars", "navigation", "seasons"],
    summary: "A small close cluster, seven sisters by the old count, six by any eye I have met. They mark the sailing season; at this time of year they rise before dawn in the east.",
    body: `## What is told

- Seven daughters of Atlas, set in the sky together.
- Their dawn rising begins the season for the harvest and for sailing. Their dawn setting, in autumn, ends it ([[voyage/day-437-equinox]]).
- The doves that carry ambrosia to Zeus have the same name, which Circe mentioned without explaining. See [[knowledge/wandering-rocks]].

## What I have checked

- I count six. On the best night on Ogygia I thought there might be a seventh. I have recorded six.
- In early July they rise in the east some hours before the sun and are well up by first light.

## Standing

| Claim | Status |
|---|---|
| Seven stars | Six seen |
| Their dawn rising marks the sailing season | Consistent with what I have seen of the weather. See [[studies/july-weather]]. |

## For the crossing

Not a steering star; they rise too far round to the east and move too far. Two uses:

1. **A clock.** When they are up in the east, dawn is a few hours off. That tells me when to rest and when to watch.
2. **A check on the season.** They are rising before dawn. The season is open ([[ogygia/weather/launch-window]]). It will not stay open for ever.

Filed under [[knowledge/_index]]. See [[knowledge/great-bear]] for steering.`,
    links: ["knowledge/_index.md", "knowledge/wandering-rocks.md", "studies/july-weather.md", "knowledge/great-bear.md", "voyage/day-437-equinox.md", "ogygia/weather/launch-window.md"],
    fields: { source: "sailors' lore; own observation", proved: "partly" },
  },
  {
    path: "knowledge/bootes.md",
    title: "Boötes",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["stars", "navigation"],
    summary: "The ploughman behind the Wain, slow to set. In July it is high in the evening and down by the small hours. A clock for the first half of the night.",
    body: `## What is told

Boötes, the herdsman or ploughman, follows the Wain around the north. It is called "late-setting" because it sinks slowly, in a long slant, and seems reluctant to go.

## What I have checked

- Its bright star stands out on its own, warm and steady, a hand's breadth or two off the end of the Bear's tail.
- In the evenings this month it is high in the west and south-west after dark.
- It sets in the west-north-west in the small hours, slowly, as the name says.

## Standing

Proved as told.

## For the crossing

Not a steering star; it moves too far. Its uses are:

| Use | How |
|---|---|
| Find the Bear quickly | Follow the curve of the tail back from its bright star |
| Tell the hour | High at dusk; low in the west around the middle of the night; gone before the Pleiades are well up |
| Check the left hand ([[decisions/sail-by-the-bear]]) | Early in the night it is ahead and to the left of the heading; as it sets it moves round to the left beam |

Calypso named it with the Pleiades and the Bear when she gave me the directions ([[ogygia/build/sailing-directions]]). I have recorded it as she named it, and the use as my own.

Filed under [[knowledge/_index]]. See [[knowledge/great-bear]] and [[studies/steering-by-the-bear]].`,
    links: ["knowledge/_index.md", "knowledge/great-bear.md", "studies/steering-by-the-bear.md", "decisions/sail-by-the-bear.md", "ogygia/build/sailing-directions.md"],
    fields: { source: "sailors' lore; own observation", proved: "yes" },
  },
  {
    path: "knowledge/orion.md",
    title: "Orion",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["stars", "navigation", "seasons"],
    summary: "The hunter the Bear keeps watch on. In July he rises only just before dawn; his rising at first light belongs to high summer.",
    body: `## What is told

- A hunter, loved by Dawn and killed for it by Artemis, at the gods' jealousy.
- The Bear turns in its place and watches him, as if wary.
- His dawn rising comes in high summer, the time for threshing.

Calypso told me the story of Dawn and Orion herself, years ago, and why she told it I did not understand until day 3647 ([[ogygia/build/day-3647-the-order]]).

## What I have checked

- His belt is three bright stars in a short straight line, unmistakable.
- In early July he is under the horizon nearly all night. By the end of the month his shoulders show in the east just before first light.

## Standing

| Claim | Status |
|---|---|
| The Bear faces him | True as a description of where they sit |
| His dawn rising is a summer sign | Consistent with what I have seen |

## For the crossing

Not a steering star at this season; he is barely up. His use is as a calendar. If I see him rising clear before dawn and Scheria is not yet in sight, I am late against the plan of 29 July ([[voyage/legs/ogygia-to-scheria]]).

- [ ] Note the first morning his belt clears the horizon.

Filed under [[knowledge/_index]]. See [[knowledge/great-bear]] and [[studies/crossing-distance-and-margin]].`,
    links: ["knowledge/_index.md", "knowledge/great-bear.md", "studies/crossing-distance-and-margin.md", "ogygia/build/day-3647-the-order.md", "voyage/legs/ogygia-to-scheria.md"],
    fields: { source: "sailors' lore; Calypso; own observation", proved: "partly" },
  },
  {
    path: "knowledge/beaching.md",
    title: "Beaching a ship",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-10",
    status: "settled",
    tags: ["seamanship", "harbours"],
    summary: "Bring her in stern first on a sloping beach, haul her up past the tide mark, and leave her pointing to sea. A raft cannot be hauled and must be brought in some other way.",
    body: `## The practice

1. Choose open sand or fine shingle, sloping, with no rock under the water in front of it.
2. Turn the ship outside the surf line and back in, stern first, on oars.
3. When the stern touches, every man over the side and hauling.
4. Up above the wash. Props under the hull on both sides.
5. The bow faces the sea. If we have to leave in a hurry, we push and we are away.

## Where it held and where it did not

| Place | Beached or moored | Result |
|---|---|---|
| Most landfalls | Beached | Ships kept |
| Land of the Laestrygonians | Eleven moored inside a closed harbour | Eleven lost ([[crew/losses/laestrygonians]]) |
| The same, ship 1 | Moored outside to a rock | Kept ([[decisions/moor-outside-the-harbour]]) |
| Thrinacia | Hauled into a hollow cave from the weather | Kept, until we sailed ([[voyage/day-1050-wind-still-south]]) |

## Standing

Proved over ten years and a few hundred landings.

## For the crossing

The raft is heavier than any ship of its length and I am one man. It will not be hauled up anywhere.

- Come ashore on a falling sea, onto sand, and let it ground.
- If the surf is heavy, do not ride it in. Get off and swim, and lose the raft before losing myself.
- Look for a river mouth: calm water and fresh water in one place. See [[knowledge/reading-a-coast]] and [[studies/raft-versus-ship]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "knowledge/reading-a-coast.md", "studies/raft-versus-ship.md", "crew/losses/laestrygonians.md", "decisions/moor-outside-the-harbour.md", "voyage/day-1050-wind-still-south.md"],
    fields: { source: "seamanship; own practice", proved: "yes" },
  },
  {
    path: "knowledge/mooring.md",
    title: "Mooring stones and stern cables",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2017-02-02",
    status: "settled",
    tags: ["seamanship", "harbours"],
    summary: "Drop the stones from the bow, take the stern cables ashore to a rock or tree. In a sheltered harbour you need neither, which should have been the warning.",
    body: `## The gear

- **Mooring stones.** Heavy pierced stones carried in the bow, dropped on lines to hold the head of the ship off the shore.
- **Stern cables.** Twisted lines run from the stern to a rock, a tree or a stake ashore.
- Together they hold the ship off the beach, head to sea, ready to go.

## The rule I took from day 205

The poet's description of a perfect harbour, which every sailor knows, is one where a ship needs no mooring at all: no stones, no cables, the water so still she will lie where she is left. I had always heard that as praise.

At the harbour of the Laestrygonians ([[voyage/legs/laestrygonians]]) the eleven ships went in and lay close together, because there was no swell. I tied ship 1 to a rock at the edge, outside, with a stern cable ([[decisions/moor-outside-the-harbour]]). When the rocks came down, I cut the cable with my sword ([[decisions/cut-the-cable]]), and the oars took us out.

The cable held us ready to leave. The stillness held them in. See [[knowledge/laestrygonians]].

## Standing

Proved.

## For the crossing

The raft has no stones and one line ([[ogygia/workshop/cordage]]). If I lie up anywhere before Scheria, I tie off to something I can cut with one stroke, and I stay outside anything that is enclosed.

Filed under [[knowledge/_index]]. See [[knowledge/beaching]].`,
    links: ["knowledge/_index.md", "knowledge/laestrygonians.md", "knowledge/beaching.md", "voyage/legs/laestrygonians.md", "decisions/moor-outside-the-harbour.md", "decisions/cut-the-cable.md", "ogygia/workshop/cordage.md"],
    fields: { source: "seamanship; own observation", proved: "yes" },
  },
  {
    path: "knowledge/steering-oar.md",
    title: "The steering oar",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["seamanship", "raft"],
    summary: "A long oar pivoted at the stern quarter, worked by a tiller. One man's whole attention. On the raft there is one oar and one man, and he also has to sleep.",
    body: `## How it works

- A broad-bladed oar, longer than the others, lashed at the stern quarter against a post so that it pivots.
- A tiller bar fixed across the loom, so the steersman can move it with one hand.
- Push the tiller away to turn the bow towards that side's opposite; it is learned in an afternoon and mastered never.

## What is known about it

- It must be lashed so that it can be lifted clear when beaching, or it breaks.
- In a following sea it is heavy work; the blade wants to be pulled round.
- A steersman who looks away for long is a steersman who has let the ship broach.
- On day 1084 ([[voyage/day-1084-the-storm]]) the falling mast killed our steersman at his oar ([[crew/helmsmen]]). The ship was gone before anyone could take it.

## On the raft

I made it myself from the same timber, with a tiller of seasoned wood and a lashing post set into the deck. See [[voyage/ogygia/raft]] and [[ogygia/build/steering-oar]].

| Item | Status |
|---|---|
| Oar fitted | Done |
| Spare lashing | Aboard |
| A way to hold it while I sleep | A lashing to the post, tested on the beach only |

## For the crossing

Seventeen days of steering with one pair of hands. The lashing is untested at sea. See [[studies/sleep-on-a-single-hand-crossing]] and [[studies/sail-handling-alone]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "voyage/ogygia/raft.md", "studies/sleep-on-a-single-hand-crossing.md", "studies/sail-handling-alone.md", "voyage/day-1084-the-storm.md", "crew/helmsmen.md", "ogygia/build/steering-oar.md"],
    fields: { source: "seamanship; own build", proved: "partly" },
  },
  {
    path: "knowledge/mast-stepping.md",
    title: "Stepping and lowering the mast",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["seamanship", "raft"],
    summary: "The mast stands in a box on the keel, held by forestays. Lowered into its crutch to row, raised to sail. On day 1084 the forestays parted and it killed the steersman.",
    body: `## On a ship

1. The mast stands in a socket on the keel, with its foot inside a box or tabernacle between the benches.
2. It is raised by hauling on the forestays and made fast with them, and the backstays.
3. Yard and sail are hoisted by halyards.
4. To row into wind, or to beach, it is lowered aft into a crutch and the sail is stowed.

## What it costs when it goes wrong

Day 1084 ([[voyage/day-1084-the-storm]]). The west wind came on in a single gust. Both forestays parted. The mast fell aft, and all the rigging with it, into the bilge. It struck the steersman ([[crew/helmsmen]]) on the head, and he went over the side. Then the thunderbolt, and the ship went round full of sulphur, and the men went into the water.

I lashed the mast to the keel with the leather backstay and rode them both ([[voyage/legs/the-wreck-and-charybdis]]).

## On the raft

The mast and yard ([[ogygia/build/mast-and-yard]]) are fitted into the deck and stayed. The raft cannot be rowed, so there is no reason to lower it except a storm.

- [x] Mast stepped and stayed.
- [x] Yard and sail bent on.
- [ ] Practise lowering it single-handed in a wind. Not yet done.

## For the crossing

In a storm a raft is safer with the mast down than up. Doing it alone, at night, in a wind, is the hardest single job aboard. See [[studies/sail-handling-alone]] and [[voyage/ogygia/raft]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "studies/sail-handling-alone.md", "voyage/ogygia/raft.md", "voyage/day-1084-the-storm.md", "crew/helmsmen.md", "voyage/legs/the-wreck-and-charybdis.md", "ogygia/build/mast-and-yard.md"],
    fields: { source: "seamanship; own observation", proved: "yes" },
  },
  {
    path: "knowledge/oar-counts.md",
    title: "Oars and men",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2019-07-12",
    status: "settled",
    tags: ["seamanship", "crew"],
    summary: "Fifty men to a ship, most of them at the oars. Ship 1 went from fifty to thirty-eight to thirty-one, and every loss came off the benches.",
    body: `## How a ship of the fleet was manned

| Role | Men |
|---|---|
| Oarsmen, both sides | the great part of the fifty |
| Steersman | 1 |
| Lookout at the bow | 1, from the benches when needed |
| Captain | 1, who also rows when it matters |

Fifty men out of Troy in each of twelve ships, 600 in all ([[crew/roll-calls/day-3]]). When the wind is fair, the oars come in and the men rest. When it is not, everything depends on how many benches are full.

## Ship 1, by count

From [[crew/ships/ship-01]]; the seating is in [[crew/oar-bench-rota]].

| After | Aboard |
|---|---|
| Sailing from Troy | 50 |
| Ismarus | 44 |
| The Cyclopes | 38 |
| The Laestrygonians | 38, alone of the fleet |
| Aeaea | 37 |
| Scylla | 31 |
| Thrinacia | 0 |

## What the counts meant

- At thirty-eight we could still row out of a harbour under rocks.
- At thirty-one we could not row on past Thrinacia against tired men's wishes, and I gave way ([[decisions/land-on-thrinacia]]).

## For the crossing

None. The raft has no oars, because one man cannot row a hull that weight. Every hazard on this list that we escaped by rowing, I would not escape now. See [[studies/raft-versus-ship]] and [[crew/_index]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "studies/raft-versus-ship.md", "crew/_index.md", "crew/roll-calls/day-3.md", "crew/ships/ship-01.md", "crew/oar-bench-rota.md", "decisions/land-on-thrinacia.md"],
    fields: { source: "own records", proved: "yes" },
  },
  {
    path: "knowledge/bailing.md",
    title: "Bailing",
    type: "knowledge",
    created: "2016-08-02",
    updated: "2026-07-10",
    status: "active",
    tags: ["seamanship", "raft"],
    summary: "On a ship, water in the bilge is a weight that grows. On a raft it runs through the deck and away. The danger is different, not smaller.",
    body: `## On a ship

- Every hull weeps at the seams. In a sea it ships water over the side as well.
- Bailers are leather buckets and scoops, passed hand to hand from the bilge to the side.
- In the nine days off Malea ([[voyage/day-25-driven-south]]) we bailed in turns, day and night. A ship that is not bailed gets heavy, sits low, takes more water over, and goes.

## On the raft

The raft is built of whole trees, bored and pinned ([[ogygia/build/day-3649-squaring]]), with a deck laid across on ribs. Water that comes aboard runs back out between the logs. Nothing to bail, and nothing to sink: the logs float whether the deck is wet or not.

The danger is other:

| Danger on a ship | Danger on the raft |
|---|---|
| Fills and sinks | Does not fill |
| Holed on a rock | Logs are thick; not likely |
| Overwhelmed by a wave | Swept clean by a wave, with the man on it |
| Loses the mast | Same |
| Breaks up | The pins and lashings work loose in a long sea and the logs part |

## For the crossing

- Lash myself to the raft in a sea, with a line I can cut.
- Keep the stores under the bulwark of willow ([[ogygia/build/bulwarks]]) and lashed down: anything loose goes over the side with the first big sea.
- Check the pins each morning.

See [[voyage/ogygia/raft]] and [[studies/raft-versus-ship]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "voyage/ogygia/raft.md", "studies/raft-versus-ship.md", "voyage/day-25-driven-south.md", "ogygia/build/day-3649-squaring.md", "ogygia/build/bulwarks.md"],
    fields: { source: "seamanship; own build", proved: "partly" },
  },
  {
    path: "knowledge/watering-parties.md",
    title: "Watering parties",
    type: "knowledge",
    created: "2016-07-21",
    updated: "2026-07-10",
    status: "settled",
    tags: ["seamanship", "provisions", "crew"],
    places: ["place:ismarus", "place:laestrygonians"],
    summary: "Every landfall started with water. Small party, armed, back by dark. The parties are where the voyage lost men first.",
    body: `## The practice

1. Before anything else at a landfall: water.
2. Send a small party, armed, with every jar and skin.
3. Leave the ship ready to go and a guard on the beach.
4. Back before dark, and nobody stays to look around.

## What happened when it was not kept

| Landfall | What went wrong |
|---|---|
| Ismarus, day 9 | The men would not leave the wine and the sheep on the beach. The Cicones came back with their neighbours in the morning. 72 lost, six from each ship ([[decisions/stay-the-night-at-ismarus]]). |
| The Lotus-eaters, day 30 | The scouts ate ([[crew/lotus-eaters]]). No loss, by force. |
| The Laestrygonians, day 205 | The scouts met a girl at a spring and were shown the way to her father's house. |
| Aeaea, day 247 | The scouts saw smoke and went towards it ([[crew/aeaea-scouting-party]]). |

The pattern is the same each time: the party went further than the water.

## Standing

Proved: the rule is sound, and the crew did not keep it, and I did not make them.

## For the crossing

Seventeen days, one skin, no landfall planned before Scheria. There will be no watering party. If I touch any shore before Scheria, it is to drink and fill the skin ([[ogygia/stores/water]]) and go: no further than the water. See [[studies/water-ration]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "studies/water-ration.md", "decisions/stay-the-night-at-ismarus.md", "crew/lotus-eaters.md", "crew/aeaea-scouting-party.md", "ogygia/stores/water.md"],
    fields: { source: "own records", proved: "yes", cost: "72 men at Ismarus" },
  },
  {
    path: "knowledge/reading-a-coast.md",
    title: "Reading a coast",
    type: "knowledge",
    created: "2016-08-11",
    updated: "2026-07-11",
    status: "active",
    tags: ["seamanship", "harbours", "navigation"],
    summary: "Smoke means people; a sheltered harbour means no swell and no way out; a river mouth means water. Read from the sea, before anyone goes ashore.",
    body: `What can be learned about a coast from outside it, written up after the Lotus-eaters and corrected after each landfall since.

## Signs and what they have meant

| Sign | What it meant | Where learned |
|---|---|---|
| Smoke inland | People. Possibly a house; possibly a host who drugs guests. | Aeaea ([[voyage/day-246-aeaea-arrival]]) |
| Smoke from caves, no fields | Herdsmen, no farming, no law | The Cyclopes |
| A harbour closed by cliffs, no swell, narrow mouth | No way out under attack | The Laestrygonians ([[voyage/legs/laestrygonians]]) |
| Wild goats unafraid of men | No people, no hunters | The island off the Cyclopes ([[voyage/day-96-goat-island]]) |
| A river mouth | Fresh water, a sand bar, a soft landing | Many |
| Breakers on a shore with no beach | Rock, and no landing | The strait |
| The sound of surf at night | Land within a short row | Many |

## The rules

1. Look from the sea first, as long as there is light.
2. Choose open beach over closed harbour.
3. Note the way out before the way in.
4. Smoke is a question, not an answer.

## For the crossing

Scheria is unknown. I know its name and its direction from [[people/calypso]] and nothing about its shore. When I raise it, I will have one look before the current makes the choice for me. See [[studies/signs-of-land]] and [[knowledge/beaching]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "people/calypso.md", "studies/signs-of-land.md", "knowledge/beaching.md", "voyage/day-246-aeaea-arrival.md", "voyage/legs/laestrygonians.md", "voyage/day-96-goat-island.md"],
    fields: { source: "own observation", proved: "yes" },
  },
  {
    path: "knowledge/raft-construction.md",
    title: "How a raft is built",
    type: "knowledge",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "settled",
    tags: ["raft", "seamanship"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "What I knew and what I learned, building one in four days. The method, separate from the record of this particular raft.",
    body: `The record of the raft itself is [[voyage/ogygia/raft]]. This is the method, so that it is written down somewhere other than my hands.

## Timber

- Alder, poplar and fir, tall and long dead, seasoned and dry so that they float high.
- [[people/calypso]] showed me where they stood, at the end of the island.
- Twenty trees ([[ogygia/build/timber-log]]), seven fir, seven alder and six poplar, felled with her bronze double axe ([[ogygia/workshop/double-axe]]) on its olive-wood haft and trimmed square with the polished adze.

## Joining

1. Bore the logs through with the augers she brought.
2. Fit them to each other and drive in pegs.
3. Fasten them with joints, as a good shipwright joins a hull.
4. Make it broad: as broad as the floor of a wide merchant ship.

## Above the logs

- Ribs set close, and the deck laid on them with long planks.
- A mast, and a yard to fit it.
- A steering oar.
- A bulwark of woven willow all round, against the sea, with brushwood laid inside.
- Ballast.

## The sail

She brought cloth for it ([[ogygia/workshop/sail-cloth]]). I cut it and made it, and fitted the braces, halyards and sheets. Then I levered the raft down to the tide line on rollers.

## Standing

Built in four days, days 3648 to 3651 ([[decisions/build-rather-than-wait]]). On its rollers at the tide line; not yet floated, and untested in any sea.

## For the crossing

It is what I am crossing on. See [[studies/raft-versus-ship]].

Filed under [[knowledge/_index]] and [[voyage/ogygia/_index]].`,
    links: ["knowledge/_index.md", "voyage/ogygia/raft.md", "people/calypso.md", "studies/raft-versus-ship.md", "voyage/ogygia/_index.md", "ogygia/build/timber-log.md", "ogygia/workshop/double-axe.md", "ogygia/workshop/sail-cloth.md", "decisions/build-rather-than-wait.md"],
    fields: { source: "own build; Calypso", proved: "untested at sea" },
  },
  {
    path: "knowledge/sea-provisions.md",
    title: "Provisions that keep at sea",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-11",
    status: "active",
    tags: ["provisions", "seamanship"],
    people: ["person:calypso"],
    summary: "Barley meal in leather bags, wine in jars and skins, dried meat, cheese. What spoils: anything fresh, and water in the sun. For the raft: bread, wine, water and relishes from Calypso, not all aboard yet.",
    body: `## What keeps

| Food | Keeps | Notes |
|---|---|---|
| Barley meal in close-sewn leather bags | Months | The staple. Mixed with water or wine. |
| Wine, in sealed jars | Years | Maron's strong wine ([[crew/ismarus-wine-ration]]) was mixed twenty measures of water to one. |
| Wine, in skins | Weeks | Sours in the heat. |
| Hard cheese | Weeks | |
| Dried and salted meat | Weeks | Makes you thirsty. |
| Bread, twice baked | A fortnight or so | Moulds if wet. |

## What does not keep

- Anything fresh: fruit, meat, fish.
- Water in skins in the sun. It goes flat in days and foul in a fortnight.

## What happened on Thrinacia

The ship's stores ([[crew/thrinacia-provisions]]) lasted until the first weeks of the wind. Then the men fished and hunted birds with bent hooks ([[voyage/day-1062-stores-out]]). Then they did what [[decisions/cattle-of-helios]] records.

## On the raft

Given by [[people/calypso]] ([[ogygia/stores/provisions-aboard]]):

- [x] A skin of wine, aboard
- [x] A larger skin of water, about 18 litres, aboard
- [ ] The bag of bread, fifty-one loaves, and relishes: not yet aboard
- [ ] A second skin of wine, not yet aboard
- [ ] Two more jars of water, about 10 litres each: proposed, not yet aboard

## For the crossing

Bread is the limit on food, water is the limit on everything. Ration water first, then bread. Wine can be mixed down to stretch water; it cannot replace it. See [[studies/water-ration]] and [[studies/provisions-for-seventeen-days]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "decisions/cattle-of-helios.md", "people/calypso.md", "studies/water-ration.md", "studies/provisions-for-seventeen-days.md", "crew/ismarus-wine-ration.md", "crew/thrinacia-provisions.md", "voyage/day-1062-stores-out.md", "ogygia/stores/provisions-aboard.md"],
    fields: { source: "seamanship; Calypso", proved: "yes" },
  },
  {
    path: "knowledge/wounds.md",
    title: "Wounds",
    type: "knowledge",
    created: "2016-07-15",
    updated: "2026-07-10",
    status: "active",
    tags: ["medicine"],
    summary: "Bind it, staunch it, sing over it if you know the words. I carry a boar's scar on the thigh from Parnassus, bound by my uncles. On the raft there is nobody to bind anything.",
    body: `## What I know, and from whom

- **From the sons of [[people/autolycus]]**, my mother's brothers, when the boar opened my thigh above the knee on Parnassus as a boy: they bound the wound with skill and checked the dark blood with an incantation, and it healed. The scar is the one mark on me anyone at home would know, [[people/eurycleia]] first.
- **From the field at Troy**: pull the arrow out along its line, not against the barbs. Wash with wine. Bind with clean linen. Sprinkle a bitter root, crushed, if there is a healer who knows which.
- **From Circe**: her ointment restored the men, but that was a god's work and not a remedy.

## What to do alone

| Wound | Do |
|---|---|
| Cut from timber or line | Wash with sea water, then wine. Bind tight with sail cloth. |
| Splinter | Out at once, along its line |
| Rope burn on the hands | Bind, keep dry, steer with the other hand |
| Crush, from the yard or oar | Bind, and do not use it until it can bear weight |
| Sun on the skin | Cover. Wet cloth over the head and neck. |

## Standing

Proved on others and once on me. Untested alone.

## For the crossing

The likeliest wounds are from my own handling: hands on lines, feet on wet logs. The cure is not to get them.

- [ ] Strips of sail cloth ([[ogygia/workshop/sail-cloth]]) set aside for binding.

Filed under [[knowledge/_index]]. See [[knowledge/fevers]].`,
    links: ["knowledge/_index.md", "knowledge/fevers.md", "people/autolycus.md", "people/eurycleia.md", "ogygia/workshop/sail-cloth.md"],
    fields: { source: "Autolycus's sons; the field at Troy", proved: "partly" },
  },
  {
    path: "knowledge/fevers.md",
    title: "Fevers and thirst",
    type: "knowledge",
    created: "2019-07-12",
    updated: "2026-07-10",
    status: "active",
    tags: ["medicine", "provisions"],
    places: ["place:ogygia"],
    summary: "Nine days adrift taught most of what is here. Heat, salt and thirst look like a fever and are not; a fever on top of them kills.",
    body: `Written on Ogygia, when I could hold a stylus again, from the nine days on the keel between Charybdis and this beach ([[voyage/legs/drift-to-ogygia]]).

## What I saw in myself

| Day adrift | Signs |
|---|---|
| 1 to 3 | Thirst, salt sores, sun on the head |
| 4 to 6 | Headache that does not lift at night, little water passed, cramps |
| 7 to 9 | Confusion. Seeing land that was not there. Could not tell days apart. |

I was not feverish in the way a camp fever is: no shaking, no sweat. It was thirst and sun. A real fever on top of it would have finished me.

## What I would do differently, and will

1. Cover the head and neck all day, wet if possible.
2. Drink a little often, not much at once.
3. Do not drink the sea. I did not, and it is the one thing I got right.
4. Move as little as possible in the heat of the day.
5. Write the day number each morning ([[ogygia/routine/day-count]]), so that I know it later.

## What Calypso does for fever

Rest in the cool of the cave, water mixed with a little wine, broth, and sleep. She treated me with it on arrival, day 1095 ([[ogygia/island/day-1095-landfall]]). It worked.

## For the crossing

Fever at sea I cannot treat. Thirst I can manage, by ration. See [[studies/water-ration]] and [[knowledge/wounds]].

Filed under [[knowledge/_index]].`,
    links: ["knowledge/_index.md", "studies/water-ration.md", "knowledge/wounds.md", "voyage/legs/drift-to-ogygia.md", "ogygia/routine/day-count.md", "ogygia/island/day-1095-landfall.md"],
    fields: { day: 1095, source: "own observation; Calypso", proved: "yes" },
  },
];

const studies: LibraryDocument[] = [
  {
    path: "studies/steering-by-the-bear.md",
    title: "Steering by the Bear, east of north",
    type: "study",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "active",
    tags: ["navigation", "stars", "crossing"],
    people: ["person:calypso"],
    places: ["place:ogygia", "place:scheria"],
    summary: "Calypso's instruction made into numbers: the heading is about 50 degrees, and the Bear sits between the left beam and the left bow depending on the hour.",
    body: `## The instruction

[[people/calypso]], day 3651 ([[ogygia/build/sailing-directions]]): keep the Great Bear on your left hand as you sail, and sail east of north. That is all she said.

## The heading

On the map in this brain, Scheria lies about 632 km from Ogygia, on a bearing of about **50 degrees**: north-east, a little nearer east than north. "East of north" is right, and not precise. The work below is to turn "on the left hand" into something I can hold to at two in the morning.

## Where the Bear is during a July night

It does not stay in one place. It swings round the pole, and at this latitude its body can sit a long way either side of due north. Observed from the beach this month ([[omens/day-3650-the-bear]]):

| Time | The Bear | Its bearing | Angle off the bow |
|---|---|---|---|
| Dusk | High, in the north-west | about 320 | about 90, on the left beam |
| Middle of the night | Lower, west of north | about 330 | about 80, just forward of the left beam |
| Before dawn | Low, near due north | about 360 | about 50, on the left bow |

So "on the left hand" means the left beam early in the night, coming forward to the left bow towards morning. A man who held it on the left beam all night would bend his course north as the hours passed, and end up west of where he meant to be.

## How to hold it

1. At dusk, set the raft so the Bear is square off the left side. Note where the bow points against the stars ahead.
2. Each time the Pleiades or Boötes move a hand's breadth, bring the Bear a little further forward.
3. Before dawn, it should sit halfway between the bow and the left beam.
4. By day: the sun rises on the right bow and sets well behind the left beam.

## What can go wrong

- Cloud. Then the swell and the wind are all I have. Note their angle at dusk.
- Leeway. See [[studies/wind-for-the-heading]].
- Being too tired to count. See [[studies/sleep-on-a-single-hand-crossing]].

Background in [[knowledge/great-bear]]; the decision is [[decisions/sail-by-the-bear]]. Filed under [[studies/_index]].`,
    links: ["studies/_index.md", "people/calypso.md", "studies/wind-for-the-heading.md", "studies/sleep-on-a-single-hand-crossing.md", "knowledge/great-bear.md", "ogygia/build/sailing-directions.md", "omens/day-3650-the-bear.md", "decisions/sail-by-the-bear.md"],
    fields: { source: "Calypso; own observation", heading: "about 50 degrees", confidence: "worked" },
  },
  {
    path: "studies/crossing-distance-and-margin.md",
    title: "632 km in 17 days, and the margin",
    type: "study",
    created: "2026-07-08",
    updated: "2026-07-12",
    status: "active",
    tags: ["navigation", "crossing", "planning"],
    places: ["place:ogygia", "place:scheria", "place:ithaca"],
    summary: "The 788 km is the whole way home. The seventeen days are the open water to Scheria, about 632 km: 37 km a day. Calm days spend the margin fast.",
    body: `## The plan

Launch 12 July ([[decisions/leave-today]]). Seventeen days of open water ([[voyage/legs/ogygia-to-scheria]]). Scheria on 29 July. The planned route in this brain is **788 km**, Ogygia to Scheria to Ithaca.

The 788 is the whole way home, not the open water alone. Dividing it by seventeen gives a speed the plan never asked for.

## Split by leg

| Leg | Distance | Note |
|---|---|---|
| Ogygia to Scheria | about 632 km | Open sea, no landfall |
| Scheria to Ithaca | about 156 km | Coastal, if anyone will take me |
| Total | 788 km | |

The seventeen days are for the first leg. 632 / 17 = **37.2 km a day**, about 1.55 km an hour.

## Days to Scheria at different speeds

Speed measured by timing a chip of wood thrown from the bow until it passes the stern, against the length of the raft measured on the beach ([[ogygia/build/dimensions]]).

| Speed through the water | Per day | Days to Scheria |
|---|---|---|
| 1.0 km/h, light airs | 24 km | 26.3 |
| 1.5 km/h | 36 km | 17.6 |
| 2.0 km/h, steady breeze | 48 km | 13.2 |
| 3.0 km/h, fresh fair wind | 72 km | 8.8 |

## The margin

The plan holds at 1.55 km an hour on average. A fresh fair wind gives nearly twice that. So there is room, as long as the wind is fair.

Each calm day costs a whole day and moves the average needed for the rest:

| Calm days | Sailing days left | Speed needed |
|---|---|---|
| 0 | 17 | 1.55 km/h |
| 2 | 15 | 1.76 km/h |
| 4 | 13 | 2.03 km/h |
| 6 | 11 | 2.39 km/h |

Six calm days and the plan needs a fresh wind every remaining hour. Past that the seventeen days do not close, and [[studies/water-ration]] is the number that decides.

## Checks at sea

- [ ] Time the chip each dawn and dusk. Write the speed down.
- [ ] Day 9: if less than half the distance is run, cut the water ration.

Filed under [[studies/_index]]. See [[knowledge/orion]] for the calendar check.`,
    links: ["studies/_index.md", "studies/water-ration.md", "knowledge/orion.md", "decisions/leave-today.md", "voyage/legs/ogygia-to-scheria.md", "ogygia/build/dimensions.md"],
    fields: { distance: "788 km", leg: "632 km", days: 17, confidence: "worked" },
  },
  {
    path: "studies/water-ration.md",
    title: "Water: one skin, seventeen days",
    type: "study",
    created: "2026-07-09",
    updated: "2026-07-12",
    status: "open",
    tags: ["provisions", "crossing", "planning"],
    people: ["person:calypso"],
    summary: "One skin holds about 18 litres. Seventeen days at a bearable ration needs 34. The shortfall is 16 litres before any delay, and July does not rain.",
    body: `## What is aboard

One skin of water from [[people/calypso]], measured on the beach by filling it from the cave's jug: about **18 litres**. One skin of wine. No cask.

## What a day needs

From the nine days on the keel ([[knowledge/fevers]], [[voyage/legs/drift-to-ogygia]]) and seven July summers here:

| Ration a day | Effect, in July heat, steering |
|---|---|
| 3 litres | Comfortable. Clear head. |
| 2 litres | Bearable. Thirsty by evening. |
| 1 litre | Headache from the third day. Confusion by the seventh. |

## How long one skin lasts

| Ration | Days |
|---|---|
| 3 litres | 6 |
| 2 litres | 9 |
| 1.06 litres | 17 |

So the skin covers the plan only at the ration that cost me my judgement last time.

## The shortfall

| Plan | Needed at 2 litres | Aboard | Short |
|---|---|---|---|
| 17 days | 34 litres | 18 | 16 |
| 22 days | 44 litres | 18 | 26 |

## What can close it

- **Rain.** Not in July. See [[studies/july-weather]]. Spread the sail to catch it if it comes, but do not plan on it.
- **Wine.** Mixed with water it stretches the ration and makes it go down easier. It does not replace water; wine alone dries a man.
- **More water.** Two more jars, about 10 litres each, would bring the total to 38 litres: 2.2 litres a day for 17 days, or 1.7 litres a day for 22.
- **A landfall.** None planned before Scheria. See [[knowledge/watering-parties]].

## Decision needed before launch

- [ ] Ask Calypso for two jars ([[ogygia/build/departure-checklist]]). If yes, lash them under the bulwark, wedged, and drink from them first.
- [ ] Keep the skin out of the sun, under wet cloth.
- [ ] From day 9 at sea, if behind the plan, drop to 1.5 litres. See [[studies/crossing-distance-and-margin]].

Filed under [[studies/_index]]. Stores record: [[ogygia/stores/water]].`,
    links: ["studies/_index.md", "people/calypso.md", "knowledge/fevers.md", "studies/july-weather.md", "knowledge/watering-parties.md", "studies/crossing-distance-and-margin.md", "voyage/legs/drift-to-ogygia.md", "ogygia/build/departure-checklist.md", "ogygia/stores/water.md"],
    fields: { aboard: "18 litres", needed: "34 litres", shortfall: "16 litres", confidence: "estimated" },
  },
  {
    path: "studies/july-weather.md",
    title: "July weather on this sea",
    type: "study",
    created: "2019-08-01",
    updated: "2026-07-10",
    status: "active",
    tags: ["weather", "winds", "crossing"],
    places: ["place:ogygia"],
    summary: "Seven Julys watched from the beach. North-west winds most days, a few calms, almost no rain, and one sudden storm in every two years.",
    body: `Started in my first summer here, when I had nothing to do but watch the sea, and kept loosely for four years. Kept properly, every morning from the headland, from year five ([[ogygia/years/year-5]], [[ogygia/weather/seasons]]). Each row is the average count of days in a July, over seven; the first four Julys are from the looser notes.

## Wind, by the day's main wind

| Wind | Days in an average July |
|---|---|
| North-west | 13 |
| North (Boreas) | 6 |
| West (Zephyrus) | 4 |
| Calm, or too light to move a sail | 4 |
| South (Notus) | 2 |
| East or south-east (Eurus) | 2 |
| **Total** | **31** |

## Other things counted

| | Average July |
|---|---|
| Days with any rain | less than 1 |
| Days of haze thick enough to hide the horizon | 3, mostly on south winds |
| Sudden storms, out of a clear sky | 1 in every 2 years |
| Afternoon sea breeze onto the island | most days |

## What the pattern is

- The north-west wind sets in mid-morning, freshens through the afternoon and eases at night. It is the summer wind of this sea, and it has held these last four weeks ([[ogygia/weather/last-weeks]]).
- Boreas comes in spells of two or three days, hard, with a clear sky and a short steep sea.
- Calms come at the turn between spells.
- The south and east winds are rare and bring haze.
- Rain is almost nothing. The cisterns on the island fill in winter, not now.

## What it means for a raft heading north-east

- The common wind, north-west, is on the beam. Sailable, with leeway. See [[studies/wind-for-the-heading]].
- One in five days will be Boreas, which I cannot sail into. Expect to lose ground on those.
- Plan on four calms in seventeen days. That is the row in [[studies/crossing-distance-and-margin]] that needs 2 km an hour.
- Plan on no rain. See [[studies/water-ration]].
- The sudden storm is the one I cannot plan for. See [[studies/poseidon-risk]].

Filed under [[studies/_index]]. Winds in detail: [[knowledge/boreas]], [[knowledge/zephyrus]].`,
    links: ["studies/_index.md", "studies/wind-for-the-heading.md", "studies/crossing-distance-and-margin.md", "studies/water-ration.md", "studies/poseidon-risk.md", "knowledge/boreas.md", "knowledge/zephyrus.md", "ogygia/weather/seasons.md", "ogygia/weather/last-weeks.md", "ogygia/years/year-5.md"],
    fields: { source: "own observation", summers: 7, confidence: "observed" },
  },
  {
    path: "studies/strait-passages-compared.md",
    title: "The strait passages compared",
    type: "study",
    created: "2019-08-10",
    updated: "2026-07-09",
    status: "settled",
    tags: ["hazard", "route", "decisions"],
    people: ["person:circe"],
    places: ["place:sirens", "place:scylla", "place:charybdis", "place:messina"],
    summary: "Four hazards on one stretch of Circe's route, how each was passed, and what it cost. Advice followed exactly cost nothing; advice weighed and accepted cost six.",
    body: `Written in my first months on Ogygia, to see the passage as one thing rather than four.

## The four

| Hazard | Day | Circe's advice | What was done | Cost |
|---|---|---|---|---|
| [[knowledge/sirens]] | 1041 | Wax for the crew; bind yourself if you must hear | Done exactly ([[crew/sirens-wax]]). The wind dropped and we rowed. | 0 |
| [[knowledge/wandering-rocks]] | (1043) | One of two roads; she would not choose | Not taken | 0 |
| [[knowledge/scylla]] | 1043 | Keep close to her rock; do not stop to fight; pray to her mother | Kept close. Armed myself anyway ([[decisions/arm-against-scylla]]). | 6 |
| [[knowledge/charybdis]] | 1043 | Do not be there when she swallows | Avoided | 0 |
| Charybdis again | 1085 | None; I was alone | Clung to the fig tree until the timbers came back ([[decisions/hold-the-fig-tree]]) | 0, there was no one left |

## What the pattern shows

1. **Followed exactly, it cost nothing.** The Sirens passage is the only one where every instruction was carried out as given, and it is the only one with nothing in the loss column.
2. **Weighed and accepted, it cost six.** Scylla was a known price. I chose it over a chance of losing the whole ship; the reasoning is in [[decisions/scylla-or-charybdis]]. I did not tell the crew ([[decisions/what-to-tell-the-crew]]), and I put on armour against her advice. Neither changed the count.
3. **The road not taken cannot be judged.** I have no evidence about the Rocks except Circe's.
4. **The second Charybdis was not a decision.** Notus carried me there. What saved me was having read the place the first time: I knew the fig tree was there.

## For the crossing

There is no strait on the way to Scheria. The lesson that transfers is the first one. When I have been given exact instructions, the record says to follow them exactly. [[people/circe]] gave the route; Calypso gave the heading.

Day records: [[voyage/day-1041-sirens]] and [[voyage/day-1043-strait]]. Filed under [[studies/_index]].`,
    links: ["studies/_index.md", "knowledge/sirens.md", "knowledge/wandering-rocks.md", "knowledge/scylla.md", "knowledge/charybdis.md", "decisions/scylla-or-charybdis.md", "people/circe.md", "voyage/day-1041-sirens.md", "voyage/day-1043-strait.md", "crew/sirens-wax.md", "decisions/arm-against-scylla.md", "decisions/hold-the-fig-tree.md", "decisions/what-to-tell-the-crew.md"],
    fields: { source: "Circe; own observation", cost: "6 men", confidence: "settled" },
  },
  {
    path: "studies/forecast-after-the-crossing.md",
    title: "What the forecast still predicts",
    type: "study",
    created: "2026-07-09",
    updated: "2026-07-11",
    status: "open",
    tags: ["gods", "forecast", "ithaca"],
    people: ["person:teiresias", "person:poseidon", "person:penelope"],
    places: ["place:acheron", "place:ithaca"],
    summary: "Teiresias's forecast, clause by clause, marked fulfilled, reported or still forecast. The oar carried inland and the death from the sea are forecast, not fact.",
    body: `The forecast is in [[knowledge/teiresias-forecast]]. Each clause, checked ten years on. **Forecast** means not yet happened; the mark stays until earned.

## Clause by clause

| # | Clause | Status |
|---|---|---|
| 1 | The Earth-shaker will make the homecoming hard, for the son you blinded | Fulfilled, so far ([[oaths/polyphemus-curse]]) |
| 2 | Leave the cattle unharmed and you may yet reach Ithaca | Condition broken, day 1077 ([[decisions/cattle-of-helios]]) |
| 3 | Harm them, and I foresee ruin for ship and crew | Fulfilled, day 1084 ([[crew/losses/thrinacia]]) |
| 4 | You will come home late, in bad case, all your comrades lost | Late and alone: fulfilled. Home: not yet. |
| 5 | In a ship not your own | Open; see below |
| 6 | You will find arrogant men in your house, eating your livelihood and courting your wife | Reported ([[people/penelope]], [[ithaca/estate]]) |
| 7 | You will pay them back, by guile or in the open | Forecast |
| 8 | Then carry an oar inland, to men who know nothing of the sea and eat no salt | Forecast |
| 9 | The sign: a traveller will call the oar a winnowing fan. Plant it there and sacrifice a ram, a bull and a boar to Poseidon | Forecast |
| 10 | Then sacrifice at home to all the gods, in order | Forecast |
| 11 | Death will come gently from the sea, in a comfortable old age, your people prosperous around you | Forecast |

## The open clauses

- **Clause 5.** The raft: my build, her trees. I would like that to settle it, but wanting is not evidence.
- **Clause 8.** I will need an oar ([[oaths/teiresias-inland-journey]]). The raft has none.
- **Clause 11.** "From the sea" can mean out of it or far from it. Teiresias did not say which; I have not chosen.
- **Clause 9.** The sacrifice goes to [[people/poseidon]]: the end of the grievance, if anything is.

Filed under [[studies/_index]]. Seer: [[people/teiresias]].`,
    links: ["studies/_index.md", "knowledge/teiresias-forecast.md", "people/penelope.md", "ithaca/estate.md", "people/poseidon.md", "people/teiresias.md", "oaths/polyphemus-curse.md", "decisions/cattle-of-helios.md", "crew/losses/thrinacia.md", "oaths/teiresias-inland-journey.md"],
    fields: { source: "Teiresias", day: 620, confidence: "forecast" },
  },
  {
    path: "studies/signs-of-land.md",
    title: "Signs of land from the open sea",
    type: "study",
    created: "2026-07-09",
    updated: "2026-07-11",
    status: "active",
    tags: ["navigation", "seamanship", "crossing"],
    places: ["place:scheria"],
    summary: "Standing cloud, many birds working the water or flying one way at dusk, a change in the water, a smell on the wind. Ranked by how far off each works and how often it has misled.",
    body: `Scheria is unknown to me; I want to know it is near before I see it. What ten years at sea have taught me:

## The signs

| Sign | Works from | Misled me |
|---|---|---|
| A cloud that stays put while others move | A long day's sail | Rarely. High land makes its own cloud. |
| Many birds flying one way at dusk | A day or two's sail | Rarely. Birds that fish by day go home to roost. |
| Many birds working the water, diving and resting | A day or two's sail | Sometimes. They feed within reach of a roost. |
| A single bird circling | Says nothing | Often. One bird can be anywhere. |
| Smell of land: smoke, pine, cut hay | Some hours | Sometimes. Depends on the wind. |
| Floating leaves and twigs | Some hours | Sometimes. Currents carry them far. |
| A change in the water: from deep to lighter, or clouded | An hour or two | Rarely. Shallows or a river mouth. |
| Sound of surf | Close | Rarely. At night it is often the first sign. |

## How to use them

1. **Count the birds before reading them.** Many at work, or many going one way at dusk, means land within a day or two: so it was on the seventh day adrift ([[voyage/day-1092-adrift]]), three days before this island. One bird means nothing.
2. **Watch for standing cloud ahead and to the right.** Scheria lies north-east ([[voyage/legs/ogygia-to-scheria]]). A fixed cloud on that bearing is worth a change of course.
3. **Do not trust a single sign.** Adrift, I also saw land that was not there. See [[knowledge/fevers]].
4. **When the water changes, slow down.** Shallows and rock come with it.

## What not to do

- Read birds by what they are doing, not by their look ([[ogygia/island/birds]]). A bird going somewhere is information.
- Do not steer for the first smoke. See [[knowledge/reading-a-coast]].

Filed under [[studies/_index]]. Omens are a separate matter: [[omens/_index]].`,
    links: ["studies/_index.md", "knowledge/fevers.md", "knowledge/reading-a-coast.md", "omens/_index.md", "voyage/legs/ogygia-to-scheria.md", "voyage/day-1092-adrift.md", "ogygia/island/birds.md"],
    fields: { source: "own observation", confidence: "observed" },
  },
  {
    path: "studies/raft-versus-ship.md",
    title: "A raft's handling against a ship's",
    type: "study",
    created: "2026-07-10",
    updated: "2026-07-11",
    status: "active",
    tags: ["raft", "seamanship", "crossing"],
    places: ["place:ogygia"],
    summary: "No oars, no crew, one sail, one steering oar. It cannot sink and it cannot be rowed. Every escape on the voyage so far was made by rowing.",
    body: `Ten years on a fifty-man ship ([[crew/ships/ship-01]]); now a raft of twenty trees built in four days ([[decisions/build-rather-than-wait]]). Set side by side, so that I stop assuming the old habits will work.

## Side by side

| | Ship of the fleet | The raft |
|---|---|---|
| Hands | 50, at most | 1 |
| Oars | Full benches | None |
| Sail | Square, on a yard | Square, on a yard |
| Steering | One oar, one steersman | One oar, the same man who does everything else |
| Can it sink? | Yes, if it fills | No; the logs float |
| Can it break up? | In a storm | Yes, if the pins work loose |
| Speed, fair wind | Fast | Slow; broad and heavy |
| Into the wind | Row | Not at all |
| Across the wind | Some way, with leeway | Little; much leeway |
| Beaching | Stern first, hauled up | Ground it and leave it |

## What follows

1. **No escape by rowing.** Ismarus, the Cyclopes, the Laestrygonians, Scylla: each was escaped on oars. The defence now is not to be there.
2. **The wind decides.** A ship rows when the wind fails. A raft waits. See [[studies/wind-for-the-heading]].
3. **The danger is coming apart, not going under.** Check the pins, joints and lashings every morning.
4. **The danger is going over the side.** Nobody will turn back for me. Tie on in a sea.
5. **The landfall is final.** Whatever beach I reach, the raft stays on it.

## What it does better

It cannot be swamped. It does not need bailing; see [[knowledge/bailing]]. It needs nobody's agreement. On day 1077 ([[voyage/day-1077-the-cattle]]) a ship of thirty-one men did what thirty-one men decided. The raft will do what I decide, which removes one hazard and adds every one I would have caught by having someone else awake.

Method: [[knowledge/raft-construction]]. Record: [[voyage/ogygia/raft]]. Filed under [[studies/_index]].`,
    links: ["studies/_index.md", "studies/wind-for-the-heading.md", "knowledge/bailing.md", "knowledge/raft-construction.md", "voyage/ogygia/raft.md", "crew/ships/ship-01.md", "decisions/build-rather-than-wait.md", "voyage/day-1077-the-cattle.md"],
    fields: { source: "own build; seamanship", confidence: "reasoned" },
  },
  {
    path: "studies/provisions-for-seventeen-days.md",
    title: "Bread and wine for seventeen days",
    type: "study",
    created: "2026-07-10",
    updated: "2026-07-12",
    status: "open",
    tags: ["provisions", "crossing", "planning"],
    people: ["person:calypso"],
    summary: "Food is not the limit. Fifty-one loaves at three a day close the plan exactly, with nothing over. Wine needs a second skin, still asked for.",
    body: `## What is aboard, and what is not yet

Counted this morning, before light:

| Item | Amount | From | Aboard |
|---|---|---|---|
| Bread, twice baked | 51 loaves, in a bag ([[ogygia/stores/food-bag]]) | [[people/calypso]] | Not yet |
| Relishes | In the same bag | Calypso | Not yet |
| Wine | One skin | Calypso | Yes |
| Water | One larger skin, about 18 litres | Calypso. See [[studies/water-ration]]. | Yes |

## The arithmetic

**Bread.** 51 / 17 = **3 loaves a day**, with none over. For a man steering and handling the sail alone, three is enough and not generous.

| Days at sea | Loaves a day |
|---|---|
| 17 | 3.0 |
| 20 | 2.55 |
| 22 | 2.3 |
| 26 | 2.0 |

Down to two a day I can work. Below that, I begin to make mistakes, which I know from the last weeks on Thrinacia, when the men were fishing with bent hooks ([[voyage/day-1062-stores-out]]) and I was praying on an empty stomach.

The relishes are not counted against the bread. They make it go down, and they make a man thirsty, so they are eaten with the morning cup and not in the heat of the day.

**Wine.** One skin, mixed down, one cup in the morning and one at night. It is for the water, not instead of it. A second skin was promised and is not yet aboard ([[ogygia/stores/wine]]).

## Keeping it

- Bread in a sack inside a second sack, lashed under the bulwark, off the deck where the sea runs through.
- A day's ration taken out each dawn. The rest not touched until the next dawn.
- Wine skin out of the sun.

## What I will not do

Take anything from any shore that was not offered. See [[knowledge/thrinacia-cattle]].

## Open

- [ ] A second skin of wine.
- [ ] From day 9 at sea, if behind plan, go to two and a half loaves.
- [ ] Note the count each night in the journal.

Background: [[knowledge/sea-provisions]]. Filed under [[studies/_index]].`,
    links: ["studies/_index.md", "people/calypso.md", "studies/water-ration.md", "knowledge/thrinacia-cattle.md", "knowledge/sea-provisions.md", "ogygia/stores/food-bag.md", "voyage/day-1062-stores-out.md", "ogygia/stores/wine.md"],
    fields: { bread: "51 loaves", per_day: 3, confidence: "counted" },
  },
  {
    path: "studies/sleep-on-a-single-hand-crossing.md",
    title: "Sleep on a single-handed crossing",
    type: "study",
    created: "2026-07-10",
    updated: "2026-07-12",
    status: "open",
    tags: ["crossing", "seamanship", "planning"],
    places: ["place:aeolia", "place:thrinacia"],
    summary: "Twice on this voyage I fell asleep at the moment that mattered, and both times it cost everything. Seventeen days alone, and nobody to wake me.",
    body: `## The record

| Day | Where | I slept | What happened |
|---|---|---|---|
| 171 | In sight of Ithaca | After nine days at the sheet, holding it myself ([[decisions/keep-the-helm-nine-days]]) | The crew opened the bag of winds. Blown back to Aeolia. |
| 1077 | Inland on Thrinacia, praying | In the open, in the afternoon | The crew killed the cattle ([[voyage/day-1077-the-cattle]]). The ship and every man were lost within the week. |

Both times the danger was other men acting while I slept; the [[crew/watch-rota]] had no line for it. On the raft there are no other men. The danger is now the sea, the wind and the steering oar.

## What a night needs

The stars steer the raft, and only at night. See [[studies/steering-by-the-bear]]. So nights are for steering awake. The plan is the one sailors describe: watch the Pleiades, Boötes setting late, and the Bear, and do not let sleep come.

## A day, planned

| Hours | Do |
|---|---|
| Dusk to dawn | Steer by the stars. Awake. |
| Dawn | Check the pins and lashings. Ration out the day. Write the day number. |
| Morning, light wind | Lash the steering oar. Sleep in short spells, under the sail's shade. |
| Midday | Sleep or rest. Least wind, most heat. |
| Afternoon, wind rising | Awake. Reef if needed. |

## The limits

- Short spells only, with the oar lashed and the sail set small. A lashed oar holds a course in a steady breeze; it will not hold it in a squall.
- No sleep within sight of land. Day 171 is why.
- If I cannot keep the night watch, lower the sail and lie to until I can. A slow day is better than a lost one. See [[studies/crossing-distance-and-margin]].

## Open

- [ ] Test the oar lashing at sea, in a breeze, before the first night.

Filed under [[studies/_index]]. Aeolus: [[knowledge/aeolus]]. Thrinacia: [[decisions/cattle-of-helios]].`,
    links: ["studies/_index.md", "studies/steering-by-the-bear.md", "studies/crossing-distance-and-margin.md", "knowledge/aeolus.md", "decisions/cattle-of-helios.md", "decisions/keep-the-helm-nine-days.md", "voyage/day-1077-the-cattle.md", "crew/watch-rota.md"],
    fields: { source: "own record", confidence: "planned" },
  },
  {
    path: "studies/wind-for-the-heading.md",
    title: "Which winds serve a north-east heading",
    type: "study",
    created: "2026-07-09",
    updated: "2026-07-11",
    status: "active",
    tags: ["winds", "navigation", "crossing"],
    summary: "Each wind set against a heading of about 50 degrees on a raft that cannot sail close to the wind. Three serve, two can be used, three cannot.",
    body: `The heading to Scheria is about 50 degrees ([[decisions/sail-by-the-bear]]). The raft carries a square sail and has much leeway; it will sail with the wind behind or on the beam, and not much closer. Each wind, set against that heading:

| Wind | From | Angle to the bow | Use |
|---|---|---|---|
| Boreas | North | 50, on the left bow | Cannot sail. Drift south. |
| North-easterly | North-east | Dead ahead | Cannot sail. Drift back. |
| Eurus | East | 40, on the right bow | Cannot sail. |
| South-easterly | South-east | 85, on the right beam | Barely. Leeway carries me north-west. |
| Notus | South | 130, right quarter | Good. Haze. |
| South-westerly | South-west | Dead astern | Good. Heavy rolling. |
| Zephyrus | West | 140, left quarter | Best. |
| North-westerly | North-west | 95, on the left beam | Workable. Leeway carries me south-east. |

## Against the July pattern

Using the counts in [[studies/july-weather]] (this year's log: [[ogygia/weather/last-weeks]]):

| Group | Days in a July |
|---|---|
| Serving: west and south | 6 |
| Workable: north-west | 13 |
| Not sailable: north, east | 8 |
| Calm | 4 |

The common summer wind is the workable one, not a fair one.

## Correcting for leeway on the north-westerly

On the north-westerly the raft will slide away from the wind, south-eastward, while it moves forward. The correction is to point the bow a little north of the course, so that the slide brings it back onto the line. How much I will only know at sea.

- [ ] On the first north-westerly day, compare the Bear's angle at dusk with the wake's angle, and note the difference. That is the leeway.

## What it means

Of seventeen days, I should expect about three in which the wind carries me well, seven in which it carries me with work, and the rest lost to calm or to Boreas. The plan in [[studies/crossing-distance-and-margin]] holds only if the workable days are worked.

Filed under [[studies/_index]]. See [[knowledge/zephyrus]] and [[knowledge/eurus]].`,
    links: ["studies/_index.md", "studies/july-weather.md", "studies/crossing-distance-and-margin.md", "knowledge/zephyrus.md", "knowledge/eurus.md", "decisions/sail-by-the-bear.md", "ogygia/weather/last-weeks.md"],
    fields: { heading: "about 50 degrees", confidence: "worked" },
  },
  {
    path: "studies/sail-handling-alone.md",
    title: "Handling the sail alone",
    type: "study",
    created: "2026-07-10",
    updated: "2026-07-12",
    status: "open",
    tags: ["raft", "seamanship", "crossing"],
    summary: "Every task a crew of fifty shared, listed against one pair of hands. Most can be done. Lowering the mast in a blow is the one that cannot be practised enough.",
    body: `On the ship, the sail was a job for several men while the rest rested. On the raft it is a job for me, between steering, rationing and sleep. Each task, and whether one man can do it:

| Task | On the ship | On the raft | Done alone? |
|---|---|---|---|
| Hoist the yard | Four men on the halyard | Me, with a turn round a cleat | Yes, slowly |
| Set the sheets | Two men | Me, from the steering post | Yes. Led aft for this. |
| Trim the braces | Two men | Me | Yes, in a light wind |
| Reef, by brailing up the sail | Several men on the brails | Me, at the foot of the mast | Yes, if done early |
| Lower the yard | Several men | Me | Yes, in a moderate wind |
| Lower the mast | All hands | Me | Not tested |
| Steer while doing any of the above | The steersman | Nobody | No. The oar is lashed. |

## The rules I am taking

1. **Reef early.** A sail that is too big in a rising wind is a job for six men. A sail reefed before the wind rose is a job for one.
2. **Everything led to the steering post.** Sheets, brails, the halyard's fall ([[ogygia/workshop/cordage]]). I should be able to reach most of it with one hand on the tiller.
3. **One job at a time.** Lash the oar, do the job, unlash the oar.
4. **In real weather, the sail comes down.** The mast is the danger on day 1084 ([[voyage/day-1084-the-storm]]). See [[knowledge/mast-stepping]].

## Practice still needed

- [ ] Brail up the full sail in a breeze, from the steering post.
- [ ] Lower and re-hoist the yard, at sea.
- [ ] Lower the mast ([[ogygia/build/mast-and-yard]]). Once, on a calm morning, so that I know whether it can be done at all.

There are no other hands. Each of these has to be learned before it is needed, because there will be nobody to do it while I learn.

Filed under [[studies/_index]]. The oar: [[knowledge/steering-oar]]. The build: [[voyage/ogygia/raft]].`,
    links: ["studies/_index.md", "knowledge/mast-stepping.md", "knowledge/steering-oar.md", "voyage/ogygia/raft.md", "ogygia/workshop/cordage.md", "voyage/day-1084-the-storm.md", "ogygia/build/mast-and-yard.md"],
    fields: { source: "seamanship; own build", confidence: "planned" },
  },
  {
    path: "studies/poseidon-risk.md",
    title: "Poseidon, as a risk to the crossing",
    type: "study",
    created: "2026-07-09",
    updated: "2026-07-12",
    status: "open",
    tags: ["gods", "hazard", "crossing"],
    people: ["person:poseidon", "person:athena", "person:calypso"],
    summary: "The one hazard I cannot plan around. What is known, what is not, and the few measures that change anything.",
    body: `## What is known

- The grievance began on day 99 ([[decisions/name-at-the-stern]]) and has not lifted. See [[knowledge/poseidon-at-sea]].
- His son prayed ([[oaths/polyphemus-curse]]) that I never reach home, or that I reach it late, alone, in a ship not mine, and find trouble there. Most of that has come true.
- The crossing is seventeen days of his water with nothing between me and him but twenty trees.

## What is not known

- Where he is. Hermes came to [[people/calypso]] with Zeus's order ([[ogygia/build/day-3647-the-order]]). I do not know whether Poseidon was at that council or knows of it.
- Whether Zeus's order binds the sea or only Calypso.
- Whether [[people/athena]] asked for it.

## Risks set side by side

| Risk | Likelihood | If it happens | What I can do |
|---|---|---|---|
| Ordinary summer weather goes against me | Likely, some days | Days lost | Ration; see [[studies/water-ration]] |
| A sudden storm, of the kind seen once in two Julys | Possible | Mast down, stores lost | Reef early, lower the mast, tie on |
| A storm sent by him | Unknown | The raft breaks up | Nothing at sea except to hold on to a timber, as on day 1085 |
| He does not notice | Unknown | Landfall on 29 July | Go now |

## Measures that change anything

1. **Go now** ([[decisions/leave-today]]). Every day on the beach is a day in which he may return to where he can see me. The wind is fair. The order is given.
2. **A raft that comes apart slowly.** If he breaks it, a log is a raft. Lash the stores so that something floats with me.
3. **Nothing taken.** I will not give another god a grievance on the way.
4. **Know how to swim it.** I swam the last part of nine days once. The record is in [[knowledge/charybdis]].

## What is not a measure

Prayer to him is due, and will be made at the launch. It is not a plan; I have no reason to think he is listening for mine.

Filed under [[studies/_index]]. See [[studies/forecast-after-the-crossing]] and [[people/poseidon]].`,
    links: ["studies/_index.md", "knowledge/poseidon-at-sea.md", "people/calypso.md", "people/athena.md", "studies/water-ration.md", "knowledge/charybdis.md", "studies/forecast-after-the-crossing.md", "people/poseidon.md", "decisions/name-at-the-stern.md", "oaths/polyphemus-curse.md", "ogygia/build/day-3647-the-order.md", "decisions/leave-today.md"],
    fields: { source: "own assessment", confidence: "unknown" },
  },
  {
    path: "studies/losses-by-hazard.md",
    title: "Six hundred, by cause",
    type: "study",
    created: "2019-08-20",
    updated: "2026-07-09",
    status: "settled",
    tags: ["crew", "hazard", "decisions"],
    people: ["person:eurylochus", "person:elpenor"],
    summary: "The crew ledger sorted by what killed them, and by whether anyone chose it. More than four in five died of a single harbour.",
    body: `The crew ledger closes at six hundred embarked and six hundred lost. I have sorted it here by what kind of hazard each loss was, because the order in which they died says less than the reasons.

## The ledger, by landfall

| Landfall | Day | Lost | Kind of hazard |
|---|---|---|---|
| Ismarus | 9 | 72 | Discipline: the men would not leave the wine ([[decisions/stay-the-night-at-ismarus]]) |
| The Cyclopes | 96 | 6 | My curiosity: I wanted the guest-gift ([[decisions/wait-for-polyphemus]]) |
| The Laestrygonians | 205 | 484 | Harbour choice ([[crew/losses/laestrygonians]]) |
| Aeaea | 611 | 1 | Accident: [[crew/elpenor]] fell from the roof |
| Scylla | 1043 | 6 | Chosen price |
| Thrinacia | 1084 | 31 | An oath ([[oaths/helios]]) broken, led by [[crew/eurylochus]] |
| **Total** | | **600** | |

## By kind

| Kind | Lost | Share |
|---|---|---|
| A harbour entered | 484 | 81 % |
| Crew acting against orders or oath | 103 | 17 % |
| My own choices | 12 | 2 % |
| Accident | 1 | under 1 % |

The 103 are Ismarus and Thrinacia. The 12 are the Cyclopes and Scylla, which I count as mine.

## What it shows

1. **One mistake dwarfs the rest.** More than four in five of every man lost died in a single harbour, in one morning. The lesson of [[knowledge/laestrygonians]] is worth more than every other lesson in this brain put together.
2. **The gods killed fewer than men did.** Scylla and Thrinacia together, 37. The rest were decisions by men, mine or theirs.
3. **I was asleep for 31 of them.** See [[studies/sleep-on-a-single-hand-crossing]].
4. **The ledger is closed.** No one else will be lost from it. The dead can be counted and they can be grieved, and they cannot be given anything more to do.

Full roster: [[crew/_index]]. Filed under [[studies/_index]].`,
    links: ["studies/_index.md", "crew/elpenor.md", "crew/eurylochus.md", "knowledge/laestrygonians.md", "studies/sleep-on-a-single-hand-crossing.md", "crew/_index.md", "decisions/stay-the-night-at-ismarus.md", "decisions/wait-for-polyphemus.md", "crew/losses/laestrygonians.md", "oaths/helios.md"],
    fields: { embarked: 600, lost: 600, survivors: 1, confidence: "settled" },
  },
];

export const knowledgeDocuments: LibraryDocument[] = [...knowledge, ...studies];
