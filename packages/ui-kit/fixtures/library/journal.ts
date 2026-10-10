// Library domain: journal. See ../README.md and ./types.ts.
//
// The private log: one entry per day since Troy, named by the day count. A few
// survive from the voyage, more from the seven years on Ogygia, and the last
// six weeks are nearly complete. Plain first person; what happened, what he
// thinks, and what is on the list for tomorrow.

import type { PersonId, PlaceId } from "../types.js";
import type { LibraryDocument } from "./types.js";

interface Entry {
  day: number;
  date: string;
  place: string;
  summary: string;
  body: string;
  tags: string[];
  links: string[];
  people?: PersonId[];
  places?: PlaceId[];
}

const HUB = "journal/_index.md";

const entry = (e: Entry): LibraryDocument => ({
  path: `journal/day-${e.day}.md`,
  title: `Day ${String(e.day).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`,
  type: "journal",
  created: e.date,
  updated: e.date,
  status: "recorded",
  tags: e.tags,
  people: e.people,
  places: e.places,
  summary: e.summary,
  body: e.body,
  links: [HUB, ...e.links],
  fields: { day: e.day, place: e.place },
});

export const journalDocuments: LibraryDocument[] = [
  // The voyage, before Ogygia.
  entry({
    day: 10,
    date: "2016-07-22",
    place: "Ismarus",
    tags: ["ismarus", "crew", "losses"],
    places: ["place:ismarus"],
    summary: "Seventy-two dead, six from every ship, because the order to leave was given and not obeyed.",
    links: ["decisions/stay-the-night-at-ismarus.md", "people/maron.md", "crew/losses/ismarus.md"],
    body: `Seventy-two. Six from each ship, which is the kind of even number that looks like a decision and was not one.

I gave the order to leave at midday ([[decisions/stay-the-night-at-ismarus]]). The town was taken, the shares were divided fairly, and we had what we came for. They would not leave the wine. They sat on the beach roasting sheep while the Cicones went inland for their neighbours, and the neighbours came at dawn with horses. We fought from morning until the sun went over, and then we ran.

The priest [[people/maron]], whom we spared with his wife, gave me twelve jars of a wine so strong it is mixed twenty to one. I have it stowed on my own ship. I do not yet know what it is for.

What I keep coming back to: the order was right and it was not enough. An order that the men will not follow is a hope with my name on it.

- [ ] Count the oars on every ship and redistribute benches.
- [ ] Say the names of the dead three times at each stern before we sail, as is owed.

See [[crew/losses/ismarus]] and [[journal/_index]].`,
  }),
  entry({
    day: 97,
    date: "2016-10-17",
    place: "Land of the Cyclopes",
    tags: ["cyclopes", "crew", "losses"],
    people: ["person:polyphemus"],
    places: ["place:cyclopes"],
    summary: "Written in the dark at the back of the cave. He has taken men, two at a time, and the stone across the door cannot be moved by us.",
    links: ["journal/day-10.md", "people/polyphemus.md", "notes/do-not-give-my-name.md", "knowledge/cyclopes-customs.md", "knowledge/cyclops-door-stone.md", "decisions/blind-rather-than-kill.md", "decisions/nobody-as-the-name.md"],
    body: `Writing this with the screen turned down to nothing, at the back of the cave, among the pens.

We came in for cheese and to see what kind of host lived here. I wanted to see. That is the whole of it, and the men told me so on the way in, and I overruled them. He is [[people/polyphemus]], a son of the sea god, and he does not keep the laws of guests ([[knowledge/cyclopes-customs]]). He has taken men, two at a time. I will not write it down more exactly than that.

I cannot kill him while he sleeps. I tried the arithmetic: the stone across the door is more than twenty wagons could shift ([[knowledge/cyclops-door-stone]]). If he dies, we die in here with him.

So the plan is otherwise: [[decisions/blind-rather-than-kill]]. There is an olive trunk drying in the pen, the length of a mast. Tonight we sharpen it and harden the point in the fire. Maron's wine goes to him undiluted. When he asks my name I tell him Nobody ([[decisions/nobody-as-the-name]]), and I keep my real one to myself, as I have written in [[notes/do-not-give-my-name]].

- [ ] Choose four men by lot to hold the stake with me.
- [ ] Tie the rams in threes for the morning.

Back to [[journal/day-10]].`,
  }),
  entry({
    day: 100,
    date: "2016-10-20",
    place: "At sea, off the land of the Cyclopes",
    tags: ["cyclopes", "poseidon", "mistakes"],
    people: ["person:polyphemus", "person:poseidon"],
    places: ["place:cyclopes"],
    summary: "Out under the rams, out to the ships, and then I gave him my name from the stern. A day later I still cannot account for it.",
    links: ["journal/day-97.md", "decisions/name-at-the-stern.md", "people/poseidon.md", "voyage/day-99-escape.md", "crew/losses/cyclopes.md", "oaths/polyphemus-curse.md"],
    body: `The plan worked in every part I wrote down, and then I added a part I had not written.

We blinded him. In the morning he felt the backs of the flock at the door and never thought to feel underneath. We drove the sheep down to the ship and rowed; the log is [[voyage/day-99-escape]]. Six men are not coming home from that cave: [[crew/losses/cyclopes]].

Then, clear of the beach, I stood at the stern and told him who I was. My name, my father's name, my island. The men begged me to be quiet; he had already thrown one rock and nearly swamped us. I did it anyway. He prayed to his father with my name in the prayer ([[oaths/polyphemus-curse]]), and now the sea has an address for me.

I have written the decision up properly in [[decisions/name-at-the-stern]]. Here I only want to say plainly what it was: I did not want the credit to belong to Nobody. That is pride, and it cost nothing yesterday, and it will be charged to every leg from here. [[people/poseidon]] keeps accounts.

- [ ] Share the sheep out among the ships, as fairly as I failed to be quiet.

Previous: [[journal/day-97]].`,
  }),
  entry({
    day: 172,
    date: "2016-12-31",
    place: "Aeolia",
    tags: ["aeolia", "crew", "mistakes"],
    places: ["place:aeolia"],
    summary: "We saw the fires on Ithaca and I slept. Aeolus has turned us away as men the gods hate.",
    links: ["journal/day-100.md", "decisions/keep-the-helm-nine-days.md", "crew/aeolia-bag.md", "people/aeolus.md", "decisions/return-to-aeolus.md"],
    body: `Nine days and nights I held the sheet myself ([[decisions/keep-the-helm-nine-days]]), because I did not trust anyone else with it. On the tenth we could see the shore of Ithaca and men tending fires on it. I was so near that I let myself sleep.

They opened the bag ([[crew/aeolia-bag]]). They thought it was silver, a gift from [[people/aeolus]] that I had kept from them. It was the winds, and every wind came out at once, and we were blown back the whole way to his island.

Today I went up to his hall and asked again ([[decisions/return-to-aeolus]]). He would not have us. He said a man the gods hate so much cannot be helped by anyone, and told us to go.

I do not blame the crew as much as I would like to. I never told them what was in the bag. A secret kept from the men who row for you is not a secret, it is a debt, and they collected it.

What I wanted to say at the time and did not: we were close enough to see smoke.

- [ ] Tell the crew what every cargo is from now on.
- [ ] Find which way the current runs from here without a wind.

Previous: [[journal/day-100]].`,
  }),
  entry({
    day: 206,
    date: "2017-02-03",
    place: "At sea, off the land of the Laestrygonians",
    tags: ["laestrygonians", "crew", "losses"],
    places: ["place:laestrygonians"],
    summary: "Eleven ships in the harbour and one outside it. Thirty-eight men left, all of them on this deck.",
    links: ["journal/day-172.md", "crew/_index.md", "decisions/moor-outside-the-harbour.md", "crew/losses/laestrygonians.md", "decisions/cut-the-cable.md", "crew/roll-calls/day-206.md"],
    body: `There was a harbour with a narrow mouth and high cliffs on both sides, and the water inside was flat. Eleven captains took their ships in. I tied mine to a rock outside ([[decisions/moor-outside-the-harbour]]). I cannot say why, except that I did not like a place with one way out.

They came down from the cliffs and threw boulders until the ships broke, and then they speared the men in the water like fish. Four hundred and eighty-four: [[crew/losses/laestrygonians]]. I cut our cable ([[decisions/cut-the-cable]]) with my own sword and shouted to row, and we rowed.

Thirty-eight of us now, on one ship. The fleet that left Troy was twelve. The roll is in [[crew/_index]] and it needs rewriting from the top, and I do not have it in me tonight.

The men do not talk. Nobody has asked why I moored outside, and I am glad, because the honest answer is that I had a bad feeling and did not share it with anyone.

- [ ] Rewrite the roll: one ship, thirty-eight names. [[crew/roll-calls/day-206]]
- [ ] Ration water for an unknown passage.
- [ ] Say the names.

Previous: [[journal/day-172]].`,
  }),
  entry({
    day: 430,
    date: "2017-09-15",
    place: "Aeaea",
    tags: ["aeaea", "circe", "waiting"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    summary: "Six months on Aeaea. The men are fed, rested and whole again, and nobody but me is counting.",
    links: ["journal/day-206.md", "people/circe.md", "oaths/circe-no-harm.md", "decisions/stay-the-year.md", "crew/eurylochus.md"],
    body: `Half a year in Circe's house. I looked at the count this morning and had to check it twice.

It is easy here. That is the problem with it. The men were swine for a few days and are men again, younger-looking than before, which they mention often. There is meat and wine every night. [[people/circe]] keeps her word to the letter now that she has sworn it ([[oaths/circe-no-harm]]), which is more than I can say for most hosts.

I have not asked to leave ([[decisions/stay-the-year]]). I tell myself the season is wrong and the ship needs work, and both are true, and neither is the reason. The reason is that every leg so far has cost men, and here nobody dies.

Ithaca has not moved. My son is a small boy who has not seen me since he could walk. My wife does not know if I am alive. Those three sentences should be enough, and I keep writing them down as if writing them were the same as acting on them.

- [ ] Inspect the hull with the shipwrights.
- [ ] Ask [[crew/eurylochus]], privately, what the men are saying.

Previous: [[journal/day-206]].`,
  }),
  entry({
    day: 621,
    date: "2018-03-25",
    place: "The house of the dead",
    tags: ["acheron", "grief", "forecast"],
    people: ["person:teiresias", "person:elpenor"],
    places: ["place:acheron"],
    summary: "My mother was among the dead. I did not know she had died. She died of missing me.",
    links: ["journal/day-430.md", "knowledge/teiresias-forecast.md", "people/teiresias.md", "crew/elpenor.md", "knowledge/rites-for-the-dead.md", "people/anticleia.md", "oaths/promise-to-elpenor.md", "people/agamemnon.md"],
    body: `I went where Circe sent me and did what she said: the trench, the blood, the sword held over it until the right one came ([[knowledge/rites-for-the-dead]]).

[[people/teiresias]] drank and spoke. I have put the forecast in [[knowledge/teiresias-forecast]] word for word. Home, late and alone, in a ship not my own, if the cattle of Helios are left untouched. I have read it several times. "Alone" is the word I keep reading.

My mother came. [[people/anticleia]]. I did not know she was dead; she was alive when I sailed. I asked her what killed her, and she said it was no illness. It was missing me, and my gentleness, and not knowing. Three times I tried to hold her and three times there was nothing to hold.

[[crew/elpenor]] was there before any of them, unburied, asking for his oar on a mound by the sea ([[oaths/promise-to-elpenor]]). I had not even noticed he was gone from the roof.

[[people/agamemnon]], murdered at his own table. Achilles, who would rather be a hired hand alive. Ajax, who would not speak to me at all, and I understand why.

- [ ] Go back to Aeaea and bury Elpenor with his oar.

Previous: [[journal/day-430]].`,
  }),
  entry({
    day: 1044,
    date: "2019-05-22",
    place: "Thrinacia",
    tags: ["thrinacia", "scylla", "crew"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia", "place:scylla"],
    summary: "Six taken off the deck yesterday, and today the men voted to land on the one island I was told to pass.",
    links: ["journal/day-621.md", "voyage/day-1043-strait.md", "decisions/scylla-or-charybdis.md", "oaths/helios.md", "crew/eurylochus.md", "crew/losses/scylla.md", "decisions/arm-against-scylla.md", "decisions/land-on-thrinacia.md", "crew/oath-signatories.md"],
    body: `Thirty-one of us, not counting me. Yesterday it was thirty-seven.

I knew what was in the strait and I did not tell them all of it. Circe said the rock on the right takes six, every time, and that fighting it costs six more. I put on armour anyway ([[decisions/arm-against-scylla]]) and stood in the bow with two spears as if that would change the count. It did not. They called my name as they went up: [[crew/losses/scylla]]. The record is [[voyage/day-1043-strait]] and the reasoning is in [[decisions/scylla-or-charybdis]]. Both are true and neither says what it was like.

Tonight [[crew/eurylochus]] stood up and said the men were worn out and would land, with me or without me. I had warned them twice about this island, by name, from two sources. I lost the vote ([[decisions/land-on-thrinacia]]). I made them swear instead, every man, not to touch the herds ([[crew/oath-signatories]]). The oath is filed as [[oaths/helios]].

An oath is not a wind. We need a wind.

- [ ] Count what is left of Circe's food.
- [ ] Walk the island and find where the herds graze, so I can keep us away from them.

Previous: [[journal/day-621]].`,
  }),
  entry({
    day: 1090,
    date: "2019-07-07",
    place: "Adrift",
    tags: ["adrift", "losses", "grief"],
    places: ["place:charybdis"],
    summary: "Fifth day on the keel and mast. The ship is gone, the crew is gone, and I am the whole of the roll.",
    links: ["journal/day-1044.md", "knowledge/charybdis.md", "decisions/cattle-of-helios.md", "omens/day-1078-hides-crawled.md", "voyage/day-1084-the-storm.md", "crew/losses/thrinacia.md", "decisions/hold-the-fig-tree.md"],
    body: `Fifth day on the keel. The mast is lashed to it with the backstay, which is all that held when the ship went.

They killed the cattle while I slept. I came down from praying and smelled it before I saw it. Six days they ate, and the hides crawled ([[omens/day-1078-hides-crawled]]) and the meat lowed on the spits, and on the seventh we sailed and the storm came out of a clear sky ([[voyage/day-1084-the-storm]]). Every man was in the water: [[crew/losses/thrinacia]]. The roll closes at six hundred, and I am not on it. See [[decisions/cattle-of-helios]].

The wind took me back to the strait in the night. When the whirlpool drew down I jumped for the fig tree on the rock ([[decisions/hold-the-fig-tree]]) and hung there, like a bat, until it gave the timbers back. [[knowledge/charybdis]] has the detail. I did not know I could hold on that long.

I have no water but what falls. I have the phone in its wrap, which is absurd, and I am writing because it is the only thing I can do that is not waiting.

- [ ] Stay on the keel.
- [ ] Look for land at every dawn.

Previous: [[journal/day-1044]].`,
  }),

  // Ogygia, the seven years.
  entry({
    day: 1095,
    date: "2019-07-12",
    place: "Ogygia",
    tags: ["ogygia", "arrival"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Land on the tenth night. A beach, a cave, a woman who knew my name before I gave it.",
    links: ["journal/day-1090.md", "people/calypso.md", "ogygia/island/day-1095-landfall.md", "ogygia/island/cave.md", "knowledge/guest-friendship.md", "voyage/day-1095-ogygia.md"],
    body: `Land. Nine days on the keel and on the tenth night the sea put me on a beach ([[ogygia/island/day-1095-landfall]]).

I could not stand. I lay at the tide line until it was light and then crawled up to where the sand was dry. There is a cave ([[ogygia/island/cave]]) above the beach with a fire burning in it, and cedar smoke, and someone singing at a loom.

Her name is [[people/calypso]]. She is a goddess, the daughter of Atlas, and she lives here alone. She knew who I was before I said it. She gave me water, then food, then clothes, in that order, which is the right order ([[knowledge/guest-friendship]]) and more than most hosts have managed.

Three years since Troy fell, to the day by my count. The voyage log has it as [[voyage/day-1095-ogygia]].

I have nothing. No ship, no crew, no oars. I have this, and a forecast that said alone, and I am alone.

- [ ] Sleep.
- [ ] Find out where this island is.

Previous: [[journal/day-1090]].`,
  }),
  entry({
    day: 1096,
    date: "2019-07-13",
    place: "Calypso's cave",
    tags: ["ogygia", "arrival"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "Slept most of the day. She asked nothing about the crew, which was either tact or knowledge.",
    links: ["journal/day-1095.md", "people/calypso.md", "ogygia/island/vine.md", "ogygia/island/springs.md", "crew/losses/thrinacia.md"],
    body: `Slept until past noon. My hands are still shaped to the keel and will not open properly.

The cave is large and dry and goes back further than the firelight reaches. There are vines over the entrance ([[ogygia/island/vine]]), heavy with grapes, and four springs ([[ogygia/island/springs]]) running in four directions through meadows of parsley and violets. Alders, poplars and cypress round the edge. Birds nest in them: owls, falcons, long-necked sea birds that work the shore. It is the best-kept place I have been in since Troy.

[[people/calypso]] did not ask about the crew. She did not ask how I came to be on a keel alone. Either she has good manners or she already knows, and I suspect the second.

I ate twice. I said the names of the thirty-one from Thrinacia ([[crew/losses/thrinacia]]), quietly, outside, because they are owed it and there is nobody else here to say them.

- [ ] Walk down to the beach and see if anything else washed in.
- [ ] Ask her, carefully, how far the nearest people are.

Previous: [[journal/day-1095]].`,
  }),
  entry({
    day: 1098,
    date: "2019-07-15",
    place: "Ogygia",
    tags: ["ogygia", "arrival", "planning"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "No ships come here. She said it without any cruelty, as a fact about the weather.",
    links: ["journal/day-1096.md", "ogygia/island/shore.md", "crew/fleet-strength.md"],
    body: `Walked the beach end to end ([[ogygia/island/shore]]). Nothing else came in. Not a plank.

I asked her how far to the nearest harbour. She said no ships come here; no gods come here either, unless sent, and no men at all. The island sits in the middle of the sea, a long way from anywhere that has a name I would know. She said it without any cruelty, as a fact about the weather.

So the position is:

- No vessel.
- No crew.
- No tools of my own.
- A host who has been kind for three days and has not said what she wants.

I do know what she wants. She has not said it yet, and I am not going to make it easier by saying it first.

I can still count, though. Day 1,098 since Troy. Twelve ships, six hundred men ([[crew/fleet-strength]]), and one man on a beach writing that number down.

- [ ] Find the highest point and look in every direction.
- [ ] Do not make any promises at dinner.

Previous: [[journal/day-1096]].`,
  }),
  entry({
    day: 1102,
    date: "2019-07-19",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland"],
    places: ["place:ogygia"],
    summary: "First time up on the headland looking east. Sea in every direction and nothing on any of it.",
    links: ["journal/day-1098.md", "ogygia/island/headland.md", "ogygia/island/sightings.md"],
    body: `Climbed the headland ([[ogygia/island/headland]]) at the east end this morning. It is the highest ground on the island, a long ridge of bare rock above the beach with a flat stone at the top that will do for sitting.

Sea in every direction. Nothing on it. No smoke, no sail ([[ogygia/island/sightings]]), no line of coast. I sat until the sun was high and watched the east, because Ithaca is east, and because there is nothing else to watch.

I worked out the direction from the sun and from the stars last night. Ithaca is east and a little north. I do not know how far; further than a man can swim, nearer than it feels.

I will probably come up here most days. I am writing that down so that later I can see when it started.

- [ ] Mark the stone, so I can find the same place in rain.
- [ ] Learn the springs and which one is safe in summer.

Previous: [[journal/day-1098]].`,
  }),
  entry({
    day: 1110,
    date: "2019-07-27",
    place: "Ogygia",
    tags: ["ogygia", "island"],
    places: ["place:ogygia"],
    summary: "Two weeks of learning the island. Notes on water, wood and the shore, kept as if I might need them.",
    links: ["journal/day-1102.md", "ogygia/_index.md", "ogygia/island/springs.md", "ogygia/island/woods.md", "ogygia/island/shore.md"],
    body: `Two weeks ashore. I have walked most of the island now and I am keeping notes as if I might need them, which is a kind of hope.

## Water

Four springs, all good. The one on the north side runs coldest. None of them dried out in this heat.

## Wood

Alder, poplar, fir that reaches very high. At the far end, beyond the cave, there are tall trees that have been dead and dry for some time, standing. Seasoned wood, nobody cutting it. I noticed it the way a man notices a door.

## The shore

Only one beach a boat could land on. The rest is rock.

## The host

She weaves most mornings and sings while she does. In the evenings she sits with me and asks about Troy and never about Ithaca.

The general notes are going into [[ogygia/_index]]: [[ogygia/island/springs]], [[ogygia/island/woods]], [[ogygia/island/shore]]. This is the private copy.

- [ ] Walk the far end again and count the dry trees.

Previous: [[journal/day-1102]].`,
  }),
  entry({
    day: 1130,
    date: "2019-08-16",
    place: "Calypso's cave",
    tags: ["ogygia", "calypso"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "She said it tonight: stay. I said I have a wife. Neither of us said anything after that for some time.",
    links: ["journal/day-1110.md", "people/calypso.md", "people/penelope.md", "ogygia/island/headland.md"],
    body: `She said it tonight. Stay.

Not unkindly, and not as an order. She said she had pulled me out of the sea when no one else would have, and fed me, and that I could have the island and her and everything on it, and that there was nothing left for me to go back to that would be worth a crossing like the last one.

I said I have a wife. I said her name, [[people/penelope]].

[[people/calypso]] did not argue. She said she was not less than a mortal woman in any way you could measure, and I agreed, because it is true, and it is also not the point. Neither of us said anything after that for some time.

I do not know how long I will be here. I am writing down that on the thirty-fifth night I said no, so that if the answer ever changes I will have to look at this first.

- [ ] Go up to the [[ogygia/island/headland]] in the morning.

Previous: [[journal/day-1110]].`,
  }),
  entry({
    day: 1180,
    date: "2019-10-05",
    place: "Ogygia",
    tags: ["ogygia", "seasons"],
    places: ["place:ogygia"],
    summary: "The first autumn. The sailing season is over everywhere, which means that for once I am not falling further behind.",
    links: ["journal/day-1130.md", "ogygia/island/headland.md", "people/telemachus.md"],
    body: `The weather has turned. The first rain since I came ashore, and the sea has a long swell from the north that breaks white along the rocks.

On Ithaca they will be bringing the herds down to the lower pastures and getting the ships up the beach for the winter. Nobody sails now. That means, for a few months, that I am not falling any further behind than anyone else. It is a poor comfort but it is the one I have.

Things I have done here, so I do not think it was nothing:

1. Learned the island end to end.
2. Mended the sandals she gave me twice.
3. Gone up the [[ogygia/island/headland]] on most days.
4. Not agreed to anything.

Things I have not done:

1. Found any way to leave.

I spend too long working out what my son, [[people/telemachus]], looks like now. He was a baby. He is old enough to be walking the beach himself.

- [ ] Start practising the stars again on clear nights.

Previous: [[journal/day-1130]].`,
  }),
  entry({
    day: 1300,
    date: "2020-02-02",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland", "stars"],
    places: ["place:ogygia"],
    summary: "A clear winter night on the headland learning the sky as if I will be steering by it.",
    links: ["journal/day-1180.md", "knowledge/_index.md", "knowledge/pleiades.md", "knowledge/bootes.md", "knowledge/orion.md", "knowledge/great-bear.md"],
    body: `Up on the headland most of the night. Cold and very clear.

I am relearning the stars as if I will be steering by them. The Pleiades ([[knowledge/pleiades]]), Boötes ([[knowledge/bootes]]) going down late, Orion ([[knowledge/orion]]), and the Bear ([[knowledge/great-bear]]), which turns in its place and watches Orion and is the only one that never goes down into the ocean. It wheels round the same point all night. If I were on a deck, that is the one I would hold.

I keep the notes in [[knowledge/_index]] where they belong. What I want to keep here is that it helped. For an hour I was a man with a skill and a reason to use it, not a guest.

She asked where I had been when I came in. I told her. She looked at me for a while and then said that the stars are the same from everywhere, which is true, and also a sentence designed to end the subject.

- [ ] Sleep in the afternoon. Back up tomorrow night if it holds clear.

Previous: [[journal/day-1180]].`,
  }),
  entry({
    day: 1460,
    date: "2020-07-11",
    place: "Ogygia",
    tags: ["ogygia", "anniversary"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "A full year on the island. She marked it with a feast, and I marked it on the headland.",
    links: ["journal/day-1300.md", "people/calypso.md", "ogygia/years/year-1.md", "ogygia/routine/clothing.md", "ogygia/island/headland.md"],
    body: `One year on Ogygia today ([[ogygia/years/year-1]]). Four years since Troy, near enough.

[[people/calypso]] made a feast of it. Lamb, the good wine, honey cakes, a new cloak she wove for the purpose ([[ogygia/routine/clothing]]). She meant it kindly and I ate it and thanked her and meant that too.

In the morning before any of it I went up to the [[ogygia/island/headland]] and sat on the marked stone and said the whole roll. It takes a long time now. Six hundred names, and I have them all, ship by ship. I do it on days that matter so that they are said by somebody who knew them.

Taking stock, plainly:

| | A year ago | Today |
|---|---|---|
| Ships | none | none |
| Crew | none | none |
| Way off the island | none | none |
| Answer to her question | no | no |

The only line that has not changed is the last one, and it is the one I care about.

- [ ] Ask her, once, whether there is any way at all off this island. Ask it straight.

Previous: [[journal/day-1300]].`,
  }),
  entry({
    day: 1575,
    date: "2020-11-03",
    place: "Calypso's cave",
    tags: ["ogygia", "calypso", "immortality"],
    people: ["person:calypso", "person:penelope"],
    places: ["place:calypso-cave"],
    summary: "She offered to make me immortal and ageless, here, with her. I said no, tonight, at the hearth.",
    links: ["journal/day-1460.md", "people/calypso.md", "people/penelope.md", "ogygia/the-offer.md", "decisions/refuse-immortality.md", "people/telemachus.md", "people/laertes.md"],
    body: `She made the offer ([[ogygia/the-offer]]) tonight at the hearth, properly, the way a thing is offered when it has been thought about for a long time.

If I stay, she will make me immortal and ageless. Not a long life; no death at all. No old age. The island, her, and time with no end to it. She said it plainly and then she waited, which she does not often do.

## What it is

Everything any man has ever been promised by anyone. No grief that would ever end, but no more of it either, because there would be nobody left to lose.

## What it is not

Ithaca. My wife, who will grow old. My son, [[people/telemachus]], whom I have never seen grown. My father, [[people/laertes]], who is old already.

## What I said

No ([[decisions/refuse-immortality]]). I said it before the fire burned down, because I knew that a night spent thinking would make it seem easy, which it is not. I told her that she is more beautiful than my wife and taller and will never grow old, and that [[people/penelope]] is a mortal woman, and that I want to go home anyway. I want to see the day of my return. If a god wrecks me on the way, I will bear it; I have borne the rest.

[[people/calypso]] did not argue. She looked at me for a long time and then she went back in to the loom.

- [ ] Be kind to her tomorrow. She did not have to ask.

Previous: [[journal/day-1460]].`,
  }),
  entry({
    day: 1576,
    date: "2020-11-04",
    place: "Calypso's cave",
    tags: ["ogygia", "calypso", "immortality"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "The morning after I refused her. She was civil and quiet, and I am clearer than I have been in a long while about what the goal is.",
    links: ["journal/day-1575.md", "people/calypso.md", "goals/return-to-ithaca.md", "ogygia/island/springs.md", "decisions/refuse-immortality.md"],
    body: `The morning after. I went to the springs ([[ogygia/island/springs]]) early and she was there, and we did not speak of it. Tonight she was civil and quiet and the fire was lit.

I am not proud of it. It is not a brave thing to refuse what you do not want. What I am is clear, for the first time in a while, about what the goal is and what it is not: [[goals/return-to-ithaca]], at the price of an ordinary death some ordinary day. That is the deal. I would sign it again.

[[people/calypso]] did not have to ask, and she did not have to take the answer so well. Both of those go in the record next to the answer itself, because a record that keeps only my side of last night is not a record.

I have written it down once in [[journal/day-1575]], and filed it as [[decisions/refuse-immortality]], and I will not keep rewriting it. The question is answered. The other question, the one I asked on the anniversary, still is not.

- [ ] Headland at dawn.
- [ ] Ask her the other question, about a way off. Not yet. Soon.

Previous: [[journal/day-1575]].`,
  }),
  entry({
    day: 1600,
    date: "2020-11-28",
    place: "Calypso's cave",
    tags: ["ogygia", "calypso", "waiting"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "I asked her straight and she answered straight: not by her doing. Since then it has been easier to be civil.",
    links: ["journal/day-1576.md", "people/calypso.md", "ogygia/routine/meals.md", "ogygia/island/headland.md", "ogygia/routine/evenings.md"],
    body: `It took me months to ask the question I wrote down on the anniversary. I asked it last night.

Is there any way off this island? She said: not by her doing. She will not give me a ship because she has none, nor men, and she will not help me make one because she does not want me to go. She said both halves of that without dressing them up, and I respect her for it more than I expected to.

It has made the days easier, oddly. I know where the wall is now. I am not wondering every evening whether the offer will come round again.

I have stopped resenting the food ([[ogygia/routine/meals]]). That is something.

I have not stopped going up to the [[ogygia/island/headland]]. Most mornings. Some days I stay up there until dark. She does not come for me, and she does not ask where I have been, and on those nights the fire is lit when I come in ([[ogygia/routine/evenings]]).

- [ ] Re-mark the stone; the rain has nearly worn it.

Previous: [[journal/day-1576]].`,
  }),
  entry({
    day: 1825,
    date: "2021-07-11",
    place: "Ogygia",
    tags: ["ogygia", "anniversary"],
    places: ["place:ogygia"],
    summary: "Two years on the island. Five since Troy. My son is nearly grown, and I have nothing to write about him but arithmetic.",
    links: ["journal/day-1600.md", "ogygia/years/year-2.md", "people/telemachus.md", "people/anticleia.md", "people/laertes.md"],
    body: `Two years on Ogygia ([[ogygia/years/year-2]]). Five years since Troy, and fifteen since I last stood on Ithaca.

My son, [[people/telemachus]], was a baby when I sailed. He is fifteen or close to it. That is old enough to be counted among the men at an assembly, or nearly. I have nothing to write about him except arithmetic, and I keep doing the arithmetic because it is the nearest I can get.

My father will be old. My mother I know about ([[people/anticleia]]). Whether [[people/laertes]] knows about her, or knows about me, I cannot tell.

I said the roll at dawn, all of it.

The general feeling today is not grief, or not only. It is a kind of tiredness with how good the island is. The water is sweet, the weather is fair, the woman is a goddess and kind to me, and none of it is mine and none of it is home.

- [ ] Walk the far end and check the dry trees are still standing.
- [ ] Keep the stars up.

Previous: [[journal/day-1600]].`,
  }),
  entry({
    day: 2000,
    date: "2022-01-02",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland"],
    places: ["place:ogygia"],
    summary: "Two thousand days since Troy. A storm all night, and the headland in the morning with spray reaching the stone.",
    links: ["journal/day-1825.md", "people/poseidon.md", "ogygia/weather/seasons.md", "knowledge/poseidon-at-sea.md", "decisions/name-at-the-stern.md"],
    body: `Two thousand days since Troy.

A storm all night out of the north-west, the worst since I came ([[ogygia/weather/seasons]]). In the morning I went up the headland anyway and the spray was reaching the stone. Nothing on the sea; there never is, but on a day like this there could not be.

I thought about [[people/poseidon]] for most of the climb down. There is no god on this island but her, and none comes unless sent. The sea round it is his ([[knowledge/poseidon-at-sea]]). Every wave on the rocks this morning was, in a sense, addressed to me. I gave him my name from a stern ([[decisions/name-at-the-stern]]) and he has never once mislaid it.

The longer I am here the clearer it is that I am being kept, not lost. Kept by her, and kept off the sea by him. Whoever is arguing for me, if anyone is, is arguing slowly.

- [ ] Dry the cloak.
- [ ] Do not talk about any of this at dinner.

Previous: [[journal/day-1825]].`,
  }),
  entry({
    day: 2190,
    date: "2022-07-11",
    place: "Ogygia",
    tags: ["ogygia", "anniversary"],
    places: ["place:ogygia"],
    summary: "Three years on the island. I have started noticing that I have stopped noticing things.",
    links: ["journal/day-2000.md", "ogygia/years/year-3.md", "ogygia/island/birds.md", "ogygia/island/springs.md", "ogygia/routine/loom.md"],
    body: `Three years on Ogygia ([[ogygia/years/year-3]]). Six since Troy.

I have started to notice that I have stopped noticing things. The owls in the alders ([[ogygia/island/birds]]). The smell of the cedar in the cave. I walked past the vines this morning without seeing them. A man can get used to anything, and the danger here is not that it is hard. It is that it is easy.

So, deliberately, three things I saw today:

- A falcon working the shore, low, the whole length of the beach and back.
- The north spring ([[ogygia/island/springs]]) running faster than last summer.
- Her loom ([[ogygia/routine/loom]]), which she has had warped with the same cloth for weeks.

And one thing I did not do: I did not go up to the headland in the morning. I went at noon, late, and I stayed less long.

I am writing that down because it is the first time. If it happens again I want to have noticed.

- [ ] Headland at dawn tomorrow, not noon.

Previous: [[journal/day-2000]].`,
  }),
  entry({
    day: 2400,
    date: "2023-02-06",
    place: "Ogygia",
    tags: ["ogygia", "ithaca", "news"],
    people: ["person:penelope", "person:telemachus"],
    places: ["place:ogygia", "place:ithaca"],
    summary: "The first news from Ithaca to reach this island: men in my hall, courting my wife, eating the estate.",
    links: ["journal/day-2190.md", "ithaca/_index.md", "people/penelope.md", "people/telemachus.md", "ithaca/reported-and-remembered.md", "ithaca/hall/plan.md"],
    body: `News from Ithaca today, the first that has reached me in all these years. Reported, not seen; I am writing it down as that ([[ithaca/reported-and-remembered]]).

There are men in my hall ([[ithaca/hall/plan]]). Suitors, from Ithaca and the islands round it, courting [[people/penelope]] on the grounds that I am dead. They have been there since the summer. They eat in my house every day, at my cost, and the herds are being driven in to feed them.

She has not chosen. She is holding them off. That is all the report said of her, and it is the most important line in it.

[[people/telemachus]] is in the house. He is too young to put them out and old enough to see what they are doing.

What I can do about it from here: nothing. I have read the report nine times. Every reading ends in the same place, which is the headland, looking east, with no ship.

The household notes go in [[ithaca/_index]]. The figures will come when they come.

- [ ] Start keeping a separate record of the estate.

Previous: [[journal/day-2190]].`,
  }),
  entry({
    day: 2555,
    date: "2023-07-11",
    place: "Ogygia",
    tags: ["ogygia", "anniversary"],
    places: ["place:ogygia"],
    summary: "Four years on the island. A year of suitors in the hall, and I have done nothing about it but keep the figures.",
    links: ["journal/day-2400.md", "ithaca/estate.md", "ogygia/years/year-4.md", "people/eumaeus.md", "people/argos.md"],
    body: `Four years on Ogygia ([[ogygia/years/year-4]]). Seven since Troy. Seventeen since I left home.

A year of men in the hall, near enough. I have opened the estate record in [[ithaca/estate]] and keep it carefully, though no figures have come through yet, and keeping it is the only thing I am doing about it. A ledger is not a sword.

She is still holding. Whoever is running the estate is still running it with no instructions from me, and has needed none.

I did the roll at dawn and then I added the household to the end of it. Not the dead; the living. My wife, my son, my father. The swineherd, [[people/eumaeus]], if he is alive. The old dog, [[people/argos]]. It felt foolish and I am going to keep doing it.

The tiredness I wrote about two years ago is still here. It has company now, which is anger, and the anger is better. It at least points east.

- [ ] Check the dry trees at the far end. Still standing, last time.

Previous: [[journal/day-2400]].`,
  }),
  entry({
    day: 2557,
    date: "2023-07-13",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland"],
    places: ["place:ogygia"],
    summary: "Two days into the fifth year. A morning on the headland with nothing to report, recorded because it is most mornings.",
    links: ["journal/day-2555.md", "ogygia/island/headland.md", "ogygia/routine/household.md"],
    body: `Nothing happened today. I am writing that down because it is what most days here are, and a journal that only keeps the remarkable ones lies about the shape of the years.

Up before light. The headland ([[ogygia/island/headland]]). Cloud low in the east until mid-morning, then clear. A swell from the south-west; no wind to speak of. Nothing on the sea.

Down at noon. Ate. Walked the north spring. Mended the strap on the water skin she gave me, which I carry up the headland and which I have now mended so often it is more my work than hers.

In the evening she sang at the loom and I listened, and that was good, and I will not pretend it was not.

Two days into the fifth year on the island. If someone ever reads this record and wants to know what the seven years were, this is a fair sample of them; the pattern is in [[ogygia/routine/household]].

- [ ] Headland at dawn.

Previous: [[journal/day-2555]].`,
  }),
  entry({
    day: 2920,
    date: "2024-07-10",
    place: "Ogygia",
    tags: ["ogygia", "anniversary"],
    places: ["place:ogygia"],
    summary: "Five years on the island. I have stopped counting sails, because there have been none to count.",
    links: ["journal/day-2557.md", "journal/day-2914.md", "ogygia/island/sightings.md", "ogygia/routine/day-count.md", "knowledge/great-bear.md"],
    body: `Five years on Ogygia. Eight since Troy.

I went back and read [[journal/day-2914]] from last week. It says I have stopped counting sails, and that is true. There have been none ([[ogygia/island/sightings]]). There is no point counting a thing that does not happen; I count days instead ([[ogygia/routine/day-count]]), because they do.

What has changed in five years:

- The suitors have been in my hall for two of them.
- My son is grown.
- I know every spring, tree and rock on this island.

What has not:

- No ship.
- My answer.

She did not mark this one with a feast. I think she has stopped expecting the anniversaries to mean what she once hoped. We ate together and talked about the weather and it was a good evening, and I went up to the headland afterwards in the dark and watched the Bear ([[knowledge/great-bear]]) come round.

- [ ] Keep going up.

Previous: [[journal/day-2557]].`,
  }),
  entry({
    day: 3100,
    date: "2025-01-06",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland", "grief"],
    places: ["place:ogygia"],
    summary: "A winter day of weeping on the headland. Written down because I do not usually write it down.",
    links: ["journal/day-2920.md", "ogygia/island/headland.md", "people/laertes.md", "people/anticleia.md"],
    body: `I wept on the [[ogygia/island/headland]] today, for most of the day. I do not usually write that down. I am writing it down this once so that the record is honest about it.

There was no reason in particular. A cold morning, the sea flat and empty, and I sat on the stone and it started and I let it. My wife. My son, whose face I have to make up. My father, [[people/laertes]], on his farm. Six hundred men whose names I can say in order. My mother, [[people/anticleia]], who died of this.

It is not useful. It changes nothing on the sea. It is also, I have decided, not a failure. A man who could sit where I sit for five and a half years and not do this would be stranger than one who does.

Came down at dusk. She had a fire lit and did not ask. I ate.

Tomorrow the day count goes on, and I will go up again, and probably it will be an ordinary morning.

- [ ] Headland at dawn.
- [ ] Mend the skin again.

Previous: [[journal/day-2920]].`,
  }),
  entry({
    day: 3285,
    date: "2025-07-10",
    place: "Ogygia",
    tags: ["ogygia", "anniversary"],
    people: ["person:penelope"],
    places: ["place:ogygia"],
    summary: "Six years on the island. Nine since Troy. The suitors have been in the hall for three, if the first report still holds.",
    links: ["journal/day-3100.md", "journal/day-2400.md", "people/penelope.md", "ogygia/years/year-6.md", "ithaca/news/day-3221-laertes.md"],
    body: `Six years on Ogygia ([[ogygia/years/year-6]]). Nine since Troy.

Three years now of the suitors, if they are still there. Nothing has come about the hall since the first word of them on [[journal/day-2400]]; the one report since was about my father and his vines ([[ithaca/news/day-3221-laertes]]). The estate file has a heading for every line and no figures under it, and I read it anyway.

[[people/penelope]] is still holding, as far as I know, which is not far. She has held them three years without a word from me. Knowing her, she has found some way to make them wait that they have not yet seen through. I hope I am right and I hope nobody else has thought of it.

Next year is ten. The war took ten. I do not know what it means if the coming back takes the same, except that it will have been exactly as long as I could bear and a little longer.

- [ ] Headland at dawn.
- [ ] Walk the far end; count the dry trees again.

Previous: [[journal/day-3100]].`,
  }),
  entry({
    day: 3400,
    date: "2025-11-02",
    place: "Ogygia",
    tags: ["ogygia", "ithaca", "news"],
    people: ["person:penelope", "person:antinous"],
    places: ["place:ogygia", "place:ithaca"],
    summary: "The loom has been found out. Three years of weaving by day and unpicking by night, and one of her women told them.",
    links: ["journal/day-3285.md", "people/penelope.md", "people/antinous.md", "ithaca/news/day-3400-the-hall.md", "ithaca/loom/shroud.md", "people/laertes.md", "ithaca/loom/discovery.md"],
    body: `News from Ithaca. Reported; filed as [[ithaca/news/day-3400-the-hall]].

So that was how she held them: a loom ([[ithaca/loom/shroud]]). She told them she would choose when she had finished a shroud for my father, [[people/laertes]], and she wove it by day and unpicked it by night, by torchlight, for three years. In the fourth, one of her own women told the suitors ([[ithaca/loom/discovery]]), and they came in and caught her at it. Now she has to finish it.

I laughed when I read it, the first time in a long while, and then I stopped, because the trick is over and there is nothing behind it.

The chief of them is [[people/antinous]]. He is the one who speaks for the rest and the one who presses her hardest. I am putting his name down here as well as in his file so that I remember who it was.

[[people/penelope]] held for three years with a loom. I have held for six with a headland. Hers was the better plan.

- [ ] Write out everything I know of the hall: who, how many, since when.
- [ ] Headland at dawn.

Previous: [[journal/day-3285]].`,
  }),

  // The last six weeks.
  entry({
    day: 3610,
    date: "2026-05-31",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland", "planning"],
    places: ["place:ogygia"],
    summary: "The sailing season is open everywhere but here. An inventory of what I have, for nothing in particular.",
    links: ["journal/day-3400.md", "knowledge/great-bear.md", "ogygia/island/woods.md", "ogygia/island/shore.md"],
    body: `The sailing season is open everywhere but here. The sea from the headland has been flat and kind for a week.

I made an inventory today, for nothing in particular, because it is a thing I can do:

- One cloak, one tunic, sandals.
- One water skin, mended past counting.
- One phone, with this record on it and the roll.
- A knife she lent me years ago and never asked for back.
- No ship. No tools of my own. No crew.

I also know, from the stars, the line home: east and a little north, Bear on the left hand ([[knowledge/great-bear]]). I know the far-end trees ([[ogygia/island/woods]]) are still dry and standing. I know where the beach is ([[ogygia/island/shore]]) that a boat could be launched from. None of this is a plan. It is the parts of a plan with the middle missing.

Ten years since Troy this summer.

- [ ] Headland at dawn.
- [ ] Look again at the dry trees. Only look.

Previous: [[journal/day-3400]].`,
  }),
  entry({
    day: 3612,
    date: "2026-06-02",
    place: "Ogygia, the headland",
    tags: ["ogygia", "stars"],
    places: ["place:ogygia"],
    summary: "A clear night. Held the Bear on my left hand on the headland and pretended there was a deck under me.",
    links: ["journal/day-3610.md", "knowledge/_index.md", "knowledge/pleiades.md", "knowledge/great-bear.md", "knowledge/steering-oar.md", "knowledge/bootes.md"],
    body: `Clear night. Went up after dinner and stayed until the Pleiades ([[knowledge/pleiades]]) were well up.

I did something I have not done for a while. I faced east of north and put the Bear ([[knowledge/great-bear]]) on my left hand and held it there, standing, as if I had a steering oar ([[knowledge/steering-oar]]) under my arm and a deck under me. I held it for an hour. My arm ached by the end, which I take as a sign that I am out of practice, not that the idea is wrong.

Boötes ([[knowledge/bootes]]) slow going down. Orion late. The Bear never bathing. Same as every year; the stars do not get older here either.

The sky notes are in [[knowledge/_index]]. I added nothing new to them tonight. What was new was the hour with my arm up.

- [ ] Do it again on the next clear night, longer.

Previous: [[journal/day-3610]].`,
  }),
  entry({
    day: 3614,
    date: "2026-06-04",
    place: "Calypso's cave",
    tags: ["ogygia", "calypso"],
    people: ["person:calypso"],
    places: ["place:calypso-cave"],
    summary: "She asked again tonight why. Not whether, why. I gave her a better answer than I have before.",
    links: ["journal/day-3612.md", "people/calypso.md", "ogygia/routine/evenings.md"],
    body: `She asked again tonight. Not whether I would stay, which she has not asked in years, but why I still want to go. She asked as if she really wanted to understand it, which I think she does.

I tried to give her a better answer than I have before.

I said: it is not that Ithaca is better than here. It is smaller, rockier, poorer, and full of people who are going to need things from me. It is that it is mine, and the people on it are mine, and I am theirs. Here I am kept. There I would be owed and owing. I would rather be owed and owing.

[[people/calypso]] said nothing for a while and then said that mortals are always in debt and seem to like it. I said that was fair.

We went in. She was gentle all evening ([[ogygia/routine/evenings]]). I do not think she has ever been unkind to me, in seven years, except in the one thing.

- [ ] Headland at dawn.

Previous: [[journal/day-3612]].`,
  }),
  entry({
    day: 3616,
    date: "2026-06-06",
    place: "Ogygia",
    tags: ["ogygia", "ithaca", "estate"],
    places: ["place:ogygia", "place:ithaca"],
    summary: "Went through the estate figures again. Nothing changed by reading them, which is the point of reading them.",
    links: ["journal/day-3614.md", "ithaca/estate.md", "ithaca/stores/drawdown.md", "ithaca/suitors/roster.md", "ithaca/stores/daily-rate.md"],
    body: `Spent the morning in the estate file, [[ithaca/estate]], reading every line of [[ithaca/stores/drawdown]]. Swine, sheep, goats, cattle, wine. Each one a count of what has been eaten in my hall by men I have never met and what is left.

I did not change any of the figures. They are what the reports said and I will not round them to make myself feel better or worse. What I did was read them slowly, and work out how long each would last at the rate they are going ([[ithaca/stores/daily-rate]]). The wine goes first. The cattle go last.

Whoever is keeping the estate running is doing it well. The losses are what one hundred and eight men ([[ithaca/suitors/roster]]) eating every day would cost, not more. Nobody is stealing on top. That is not nothing.

I keep the file because one day I will have to stand in that hall and know exactly what was taken. Not to bill anyone. To know.

- [ ] Headland at dawn.
- [ ] Add a line for the household slaves, if a report ever comes.

Previous: [[journal/day-3614]].`,
  }),
  entry({
    day: 3618,
    date: "2026-06-08",
    place: "Ogygia, the headland",
    tags: ["ogygia", "penelope"],
    people: ["person:penelope"],
    places: ["place:ogygia"],
    summary: "Thinking about the loom on the headland. Three years she bought with it. I have not bought anything.",
    links: ["journal/day-3616.md", "people/penelope.md", "ithaca/loom/shroud.md", "ithaca/loom/discovery.md"],
    body: `Most of the morning on the headland thinking about my wife's loom ([[ithaca/loom/shroud]]).

Three years she bought with a piece of cloth. Every night she sat by torchlight and undid the day's work, quietly, so that the women would not hear, and every morning she started again in front of a hall full of men who were waiting for her to finish. It is the best piece of planning I have heard of in twenty years, and I was at Troy.

It was found out ([[ithaca/loom/discovery]]). That was always going to happen. A secret that needs one woman's silence every night for three years is a secret with a date on it. She knew that, and she did it anyway, because three years were worth having.

[[people/penelope]] has been doing alone, with a loom, what I have not done here with a whole island and a goddess's patience. I do not say that to punish myself. I say it because it is the truth and I want to remember it when I see her.

- [ ] Headland at dawn.

Previous: [[journal/day-3616]].`,
  }),
  entry({
    day: 3620,
    date: "2026-06-10",
    place: "Ogygia",
    tags: ["ogygia", "ithaca", "argos"],
    people: ["person:argos"],
    places: ["place:ogygia"],
    summary: "Thought about the dog today. Argos was a pup when I left, and if he is alive he is twenty.",
    links: ["journal/day-3618.md", "people/argos.md", "ithaca/household/roster.md", "ithaca/household/argos.md"],
    body: `For no reason I could find, I thought about the dog all day.

[[people/argos]]. I raised him from a pup and never got the use of him. I left for Troy before he was old enough to hunt. The young men took him out after goats and deer and hares, and he was the best on the island at it, or so the reports used to say when there were reports about dogs.

If he is alive he is twenty years old. That is very old for a dog. Nobody will be taking him hunting now. He will be lying somewhere in the yard, and nobody will be looking after him the way they should, because the house is full of other people's men.

I do not know why the dog, out of everything. Possibly because he is the one thing on Ithaca whose life has been almost exactly as long as my absence.

- [ ] Headland at dawn.
- [ ] Put the dog on the end of the roll, after the household ([[ithaca/household/roster]]). He has earned it. His file: [[ithaca/household/argos]].

Previous: [[journal/day-3618]].`,
  }),
  entry({
    day: 3622,
    date: "2026-06-12",
    place: "Ogygia",
    tags: ["ogygia", "laertes"],
    people: ["person:laertes"],
    places: ["place:ogygia"],
    summary: "My father on his upland farm, digging his vines and not coming down to the town. I understand him better every year.",
    links: ["journal/day-3620.md", "people/laertes.md", "ithaca/island/laertes-farm.md", "ithaca/news/day-3221-laertes.md", "people/anticleia.md"],
    body: `My father, [[people/laertes]], has gone up to the farm on the hill ([[ithaca/island/laertes-farm]]) and does not come down to the town. That was in the report of day 3221 ([[ithaca/news/day-3221-laertes]]) and it has not changed in any report since.

He lives with an old woman who cooks for him. He sleeps by the fire in winter with the slaves, in the ashes, and in summer on leaves on the ground in the vineyard. He digs his vines. He grieves for me, and for my mother, [[people/anticleia]], and he does not go to the hall.

I used to think that was weakness. The older I get the better I understand it. He cannot put the suitors out; he is too old and they are too many. He will not sit at a table with them. So he has gone somewhere he can do one thing well and can be left alone to do it. I have a headland. He has a vineyard. His is more use.

When I see him I am going to tell him that.

- [ ] Headland at dawn.

Previous: [[journal/day-3620]].`,
  }),
  entry({
    day: 3624,
    date: "2026-06-14",
    place: "Ogygia, the headland",
    tags: ["ogygia", "crew", "roll"],
    people: ["person:eurylochus", "person:elpenor"],
    places: ["place:ogygia"],
    summary: "Said the whole roll today, slowly, and stopped at the names I knew best.",
    links: ["journal/day-3622.md", "crew/_index.md", "crew/eurylochus.md", "crew/elpenor.md", "crew/polites.md", "crew/barrow-on-aeaea.md", "crew/perimedes.md", "crew/antiphus.md"],
    body: `Went through the whole roll today on the headland, ship by ship, slowly. The record is [[crew/_index]].

Some of the names I stop at.

[[crew/polites]], who went first into Circe's house because he heard her singing and thought it was safe. He was the one I liked best.

[[crew/elpenor]], who was not brave or clever and never claimed to be, and who fell off a roof in the dark on the last morning. I buried him with his oar ([[crew/barrow-on-aeaea]]). He asked me to.

[[crew/eurylochus]], my second, who stood up on Thrinacia and told me the men would land without me, and then led them to the herds while I slept. I have been angry with him for seven years. Today I mostly was not. He was tired and hungry and he made the decision a tired, hungry man makes. I was the one who fell asleep.

[[crew/perimedes]]. [[crew/antiphus]]. The rest, by ship.

Six hundred, and every one of them closed. The roll does not get shorter for saying it.

- [ ] Headland at dawn.

Previous: [[journal/day-3622]].`,
  }),
  entry({
    day: 3626,
    date: "2026-06-16",
    place: "Ogygia",
    tags: ["ogygia", "forecast"],
    people: ["person:teiresias"],
    places: ["place:ogygia"],
    summary: "Read the forecast again. Every clause of it has come true except the last, and the last is the one I want.",
    links: ["journal/day-3624.md", "knowledge/teiresias-forecast.md", "decisions/cattle-of-helios.md", "knowledge/thrinacia-cattle.md"],
    body: `Read [[knowledge/teiresias-forecast]] again this morning, clause by clause, against what happened.

> You may still reach home

Not yet.

> and late

Yes. Ten years late, or near it.

> and alone

Yes. Every man of six hundred.

> and in a ship not your own

There is no ship. Nothing on this island is my own; if a ship ever comes from here, it will not be.

> if nobody touches the cattle of Helios

They were touched ([[decisions/cattle-of-helios]], [[knowledge/thrinacia-cattle]]). I did not touch them. I have gone over that a thousand times and I still think the forecast was conditional on the man, not the crew. If I am wrong, I am wrong, and I will find out at sea.

He also said trouble at home. Men in my house, eating. That clause came true without anyone needing to read it.

So everything but the first. And the first is the one that matters.

- [ ] Headland at dawn.

Previous: [[journal/day-3624]].`,
  }),
  entry({
    day: 3628,
    date: "2026-06-18",
    place: "Ogygia, the far end",
    tags: ["ogygia", "timber"],
    places: ["place:ogygia"],
    summary: "Walked the far end and counted the dry trees: more than twenty, still standing. I did not touch one.",
    links: ["journal/day-3626.md", "ogygia/_index.md", "ogygia/island/woods.md"],
    body: `Walked to the far end of the island today ([[ogygia/island/woods]]) and counted the dry trees again. I have done this every few months for seven years.

More than twenty. Alder, poplar, fir, tall and dead and seasoned in the sun for longer than I have been here. They would float high. They would not split in the first sea. A man who had an axe and somebody's permission could have them down in a day.

I do not have either. The axe would have to be hers; so would the permission. I did not touch one. I put a hand on the biggest fir and stood there a while.

The island notes are in [[ogygia/_index]]. I wrote there that the trees are standing. I did not write there what I was thinking, which is that if the wall ever moves I already know where every piece of the vessel is.

- [ ] Headland at dawn.
- [ ] Work out, roughly, how many trees a raft would take. For no reason.

Previous: [[journal/day-3626]].`,
  }),
  entry({
    day: 3630,
    date: "2026-06-20",
    place: "Ogygia, the headland",
    tags: ["ogygia", "poseidon"],
    people: ["person:poseidon"],
    places: ["place:ogygia"],
    summary: "The calmest week in years, and a thought about who is not watching the sea.",
    links: ["journal/day-3628.md", "people/poseidon.md", "decisions/name-at-the-stern.md", "knowledge/poseidon-at-sea.md", "knowledge/teiresias-forecast.md", "oaths/polyphemus-curse.md"],
    body: `The calmest week I can remember on this island. Day after day of flat sea and an easy wind from the west.

I wonder if [[people/poseidon]] is away ([[knowledge/poseidon-at-sea]]). He goes to the far edges of the world sometimes, they say, to the people at the ends of the earth, to take their sacrifices and feast. When he is gone the sea is just sea.

I have no way to know. I have one fact, which is that the grievance began with [[decisions/name-at-the-stern]] and has not been closed ([[oaths/polyphemus-curse]]). He cannot stop me getting home; the forecast ([[knowledge/teiresias-forecast]]) was clear on that much. He can only make every leg of it cost something. Every leg so far has.

If the sea is calm because he is not looking, I have nothing to sail it with. If I had something to sail it with, he might be back by the time I was a day out. Both of those are true, and neither changes anything this morning.

- [ ] Headland at dawn.

Previous: [[journal/day-3628]].`,
  }),
  entry({
    day: 3632,
    date: "2026-06-22",
    place: "Ogygia",
    tags: ["ogygia", "telemachus"],
    people: ["person:telemachus"],
    places: ["place:ogygia"],
    summary: "Worked out my son's age again and wrote it down as a fact rather than a sum.",
    links: ["journal/day-3630.md", "people/telemachus.md", "people/autolycus.md", "knowledge/wounds.md", "ithaca/telemachus/remembered.md"],
    body: `[[people/telemachus]] is twenty, or near it. I am writing it as a fact this time, not as a sum.

Twenty is a man. At twenty I had been on my first boar hunt with my grandfather, [[people/autolycus]], and come home with the scar ([[knowledge/wounds]]). At twenty I could have put a hundred and eight men out of a hall, or tried.

He has grown up with a house full of strangers eating his inheritance and courting his mother, and a father who is a story. That is the only childhood he has had. I do not know what kind of man it makes. I hope stubborn. I hope careful. I do not know, and nothing I write here will change that.

What I can say is that if I ever stand in front of him I will not know his face, and he will not know mine, and one of us is going to have to prove it to the other. All I remember of him is in [[ithaca/telemachus/remembered]].

- [ ] Headland at dawn.
- [ ] Think about what I would say to him first. Not tonight.

Previous: [[journal/day-3630]].`,
  }),
  entry({
    day: 3634,
    date: "2026-06-24",
    place: "Ogygia, the headland",
    tags: ["ogygia", "headland", "grief"],
    places: ["place:ogygia"],
    summary: "A long day on the headland. Wept. Came down at dark. She said nothing, which was kind.",
    links: ["journal/day-3632.md", "journal/day-3100.md", "ogygia/island/headland.md", "ogygia/routine/loom.md"],
    body: `A long day on the [[ogygia/island/headland]]. I went up before light and came down after dark.

It was like the day in the winter last year that I wrote up as [[journal/day-3100]]. I sat on the stone and looked east and it came, for hours. This time I did not try to work out why. The why is obvious and has been for seven years.

I will say one thing that is new. I am not wishing I were dead, which I did on the keel and in the first year here. I am wishing I were home. Those are different and I am glad of the difference.

She said nothing when I came in. There was food. She sat with me while I ate and then went to her loom ([[ogygia/routine/loom]]) and sang quietly, the same song she sings most nights, and I listened to it. Seven years of kindness in the one thing she could give.

- [ ] Headland at dawn. Shorter, if I can.

Previous: [[journal/day-3632]].`,
  }),
  entry({
    day: 3636,
    date: "2026-06-26",
    place: "Ogygia",
    tags: ["ogygia", "ithaca", "suitors"],
    people: ["person:antinous"],
    places: ["place:ogygia", "place:ithaca"],
    summary: "Four years of suitors in the hall, near enough. One hundred and eight of them, and their chief.",
    links: ["journal/day-3634.md", "people/antinous.md", "ithaca/_index.md", "ithaca/suitors/roster.md", "ithaca/household/the-twelve.md", "crew/losses/laestrygonians.md"],
    body: `Wrote up everything I know of the hall ([[ithaca/suitors/roster]]), as I said I would after the loom news. The household notes are in [[ithaca/_index]]; this is the short version.

- One hundred and eight men.
- Four years, nearly, in the hall.
- From Dulichium, Same, Zacynthus and Ithaca itself.
- [[people/antinous]] at their head, and the loudest.
- They eat every day. They drink my wine. They sleep with some of the household women ([[ithaca/household/the-twelve]]).
- They have not taken my wife, because she has not chosen, and she has not chosen because she is waiting.

A hundred and eight is a number. It is less than the men I lost at the Laestrygonians' harbour in one morning ([[crew/losses/laestrygonians]]). I am writing that down not because I have a plan to deal with a hundred and eight men alone, but because I want to stop thinking of the number as impossible. It is a count. Counts can be worked.

- [ ] Headland at dawn.

Previous: [[journal/day-3634]].`,
  }),
  entry({
    day: 3638,
    date: "2026-06-28",
    place: "Ogygia",
    tags: ["ogygia", "telemachus", "waiting"],
    people: ["person:telemachus", "person:nestor"],
    places: ["place:ogygia"],
    summary: "Nothing reported of my son in months. Wrote down what I would do in his place, as a wish and not as news.",
    links: ["journal/day-3636.md", "people/telemachus.md", "people/nestor.md", "people/calypso.md", "ithaca/telemachus/remembered.md"],
    body: `No report of [[people/telemachus]] since the hall news. Nothing has come about him by name in months, and I have stopped expecting it.

So I wrote down, plainly, what I would do in his place. I am filing it as a wish, because nobody has reported anything of the kind.

- Stand up in front of the town and say what is being done to the house, so that nobody can say later they did not hear it.
- Take a ship, if nobody will give one, and go and ask the men who came home what became of me.
- Go first to [[people/nestor]] at Pylos. Nestor knew the fleet. He sailed from Troy before we did and got home. If anyone on the mainland can say where I was last seen, it is him.
- Tell nobody who would say no.

What Nestor could not tell him is where I am now, because nobody knows that but the woman in this cave, [[people/calypso]].

I have read the list back and it is a list for a man of twenty who is my son, written by a man who has never met him ([[ithaca/telemachus/remembered]]). It may be nothing like him. I am leaving it here anyway, so that if he ever does any of it I will know I hoped for it before I heard.

- [ ] Headland at dawn.
- [ ] Look for any further report.

Previous: [[journal/day-3636]].`,
  }),
  entry({
    day: 3640,
    date: "2026-06-30",
    place: "Ogygia",
    tags: ["ogygia", "penelope", "news"],
    people: ["person:penelope", "person:laertes"],
    places: ["place:ogygia", "place:ithaca"],
    summary: "Reported: the shroud is finished and off the loom. Her one formal reason to wait is gone, and her family are pressing her to marry.",
    links: ["journal/day-3638.md", "people/penelope.md", "people/laertes.md", "ithaca/news/day-3640-shroud-finished.md", "ithaca/loom/discovery.md", "people/icarius.md", "ithaca/household/penelope-standing.md"],
    body: `Another report. The shroud for [[people/laertes]] is finished and off the loom. The household notes are in [[ithaca/news/day-3640-shroud-finished]].

Since the women told on her ([[ithaca/loom/discovery]]) she has been weaving it in daylight only, with them watching. Now it is done. Her father, [[people/icarius]], and her brothers are urging her to marry. The suitors say they will not leave until she chooses. The report says [[people/penelope]] sleeps badly and keeps to her rooms.

I want to be very careful in what I write here, because it is easy to write something about her that is really about me. So only this: the loom was the last thing standing between her and a choice she has refused for four years, and it is gone, and I am the reason she needed it, and there is nothing I can do from here but keep the record honest and keep going up the headland.

I said her name at dawn. I will again tomorrow.

- [ ] Headland at dawn.
- [ ] Update her file, [[ithaca/household/penelope-standing]], with today's report, dated as arrived.

Previous: [[journal/day-3638]].`,
  }),
  entry({
    day: 3641,
    date: "2026-07-01",
    place: "Ogygia, the headland",
    tags: ["ogygia", "athena"],
    people: ["person:athena"],
    places: ["place:ogygia"],
    summary: "Nothing from Athena in seven years. I have stopped planning around her and started hoping without a plan, which is worse.",
    links: ["journal/day-3640.md", "people/athena.md", "knowledge/athena-favour.md", "decisions/name-at-the-stern.md", "people/poseidon.md"],
    body: `Seven years on this island and not one word from [[people/athena]].

At Troy she was at my shoulder. Afterwards, nothing. I have wondered whether it was the stern, the name, the grievance ([[decisions/name-at-the-stern]]); whether she would not cross her uncle, [[people/poseidon]], for me; whether she simply had other work. I do not know. Gods do not send explanations.

I wrote years ago, in [[knowledge/athena-favour]], that one should not plan around her arriving, and that is still right. Reliable in outcome, unpredictable in timing. Her outcomes have been good. Her timing has been ten years.

What I notice is that since the news of the shroud I have started hoping again, without any plan to go with it, and that is a worse state than either. Hope with a plan is work. Hope without one is waiting with extra steps.

So, the plan, such as it is: keep the trees counted, keep the stars, keep the roll, keep the estate figures, go up every morning. If the wall moves, be ready the same day.

- [ ] Headland at dawn.

Previous: [[journal/day-3640]].`,
  }),
  entry({
    day: 3642,
    date: "2026-07-02",
    place: "Calypso's cave",
    tags: ["ogygia", "roll", "losses"],
    places: ["place:calypso-cave"],
    summary: "Rain kept me in. Closed the crew ledger again on paper: six hundred out, six hundred lost, one survivor.",
    links: ["journal/day-3641.md", "crew/_index.md", "crew/fleet-strength.md", "studies/losses-by-hazard.md", "crew/roll-calls/day-1095.md"],
    body: `Rain all day, the first in weeks. Stayed in the cave. Used it to go through the crew ledger in [[crew/_index]] from the top, place by place, the way you would close a quarter's accounts.

| Where | Lost |
|---|---|
| Ismarus | 72 |
| The Cyclops's cave | 6 |
| The Laestrygonians' harbour | 484 |
| Aeaea | 1 |
| The strait | 6 |
| Thrinacia and the storm after | 31 |
| **Total** | **600** |

Six hundred embarked. Six hundred lost ([[crew/fleet-strength]], [[studies/losses-by-hazard]]). One survivor, who was not on the roll as crew. No ship returned.

It closes. It has closed since the night on the keel; the last count is [[crew/roll-calls/day-1095]]. I keep checking it because I want it to be wrong, and because it is the last thing I can do for them that is exact.

She came and sat by me while I did it and read the names over my shoulder and did not say anything about any of them. I was grateful.

- [ ] Headland at dawn, if the rain stops.

Previous: [[journal/day-3641]].`,
  }),
  entry({
    day: 3643,
    date: "2026-07-03",
    place: "Ogygia",
    tags: ["ogygia", "calypso", "staying"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Worked in her vines all morning, and caught myself thinking about how I would prune them next year.",
    links: ["journal/day-3642.md", "people/calypso.md", "ogygia/island/vine.md", "decisions/refuse-immortality.md"],
    body: `Helped in the vines over the cave mouth ([[ogygia/island/vine]]) this morning. The grapes are setting and the canes needed tying.

At one point I caught myself thinking about how I would cut them back in the winter, so that next year the bunches would hang better over the entrance. Next year. Here.

I stopped and wrote it down in my head, and now I am writing it down properly. That is how it happens. Not with an offer of immortality ([[decisions/refuse-immortality]]), which I could refuse because it was large and clear. It happens with the vines, one season at a time, until a man finds he has been planning next year's pruning in somebody else's garden.

I am not going to stop helping in the vines. [[people/calypso]] has given me seven years of food and kindness, and a morning's work is a small return. But I am going to stop planning them.

- [ ] Headland at dawn.
- [ ] Next time the thought comes, replace it with the far-end trees.

Previous: [[journal/day-3642]].`,
  }),
  entry({
    day: 3644,
    date: "2026-07-04",
    place: "Ogygia",
    tags: ["ogygia", "telemachus", "news"],
    people: ["person:telemachus", "person:nestor"],
    places: ["place:ogygia", "place:pylos"],
    summary: "Reported: my son called an assembly, lost the argument, and sailed for Pylos the same night to ask Nestor what became of me.",
    links: ["journal/day-3643.md", "journal/day-3638.md", "people/telemachus.md", "people/nestor.md", "ithaca/news/day-3644-assembly.md", "ithaca/telemachus/assembly.md", "ithaca/telemachus/ship-and-crew.md", "people/eurycleia.md"],
    body: `News, reported. Two days ago [[people/telemachus]] called an assembly, the first on the island since I sailed. He asked the town to restrain the suitors and the town did nothing ([[ithaca/telemachus/assembly]]). That same night he took a borrowed ship and a crew ([[ithaca/telemachus/ship-and-crew]]) and sailed for Pylos, to ask [[people/nestor]] if he knows what became of me. The household notes are in [[ithaca/news/day-3644-assembly]].

He did not tell his mother. He told the old nurse, [[people/eurycleia]], and made her swear not to tell for twelve days.

I have read that twice and I do not know what to feel first. He is going looking for me, which nobody has done in ten years. He is going somewhere I cannot reach him and cannot help him. He is doing it the way I would have done it: quietly, at night, and without asking anyone who would have said no.

Six days ago I wrote down, as a wish, what I would do in his place ([[journal/day-3638]]). He has done most of it. I did not make it happen by writing it, and I am not going to start believing that I did.

- [ ] Headland at dawn.
- [ ] Look for any further report.

Previous: [[journal/day-3643]].`,
  }),
  entry({
    day: 3645,
    date: "2026-07-05",
    place: "Ogygia, the headland",
    tags: ["ogygia", "telemachus", "waiting"],
    people: ["person:telemachus"],
    places: ["place:ogygia", "place:pylos"],
    summary: "No further report. If the wind held he has been at Pylos two days. Worked the passage out twice and went up the headland.",
    links: ["journal/day-3644.md", "people/telemachus.md", "ogygia/island/headland.md", "people/nestor.md", "ithaca/telemachus/ship-and-crew.md"],
    body: `No further report today.

I worked the passage out twice on the [[ogygia/island/headland]], the way I would for a ship of my own. Ithaca to Pylos is a night's run with a fair wind down the coast, keeping the land on the left. If the westerly they had held, [[people/telemachus]] was on the beach at Pylos by the morning after he sailed, and has had two days there since.

Two days with [[people/nestor]] is two days of being told about the war at length, by a man who tells it well and expects to be listened to. That will do him no harm. He will learn more about his father in an evening there than in twenty years at home.

What I do not know is anything. Whether he got there. Whether the crew ([[ithaca/telemachus/ship-and-crew]]) are men who will bring him back. Whether anyone in the hall has noticed that he is gone.

I am writing this down because a day with no news is still a day in the record, and because if I do not write it I will spend the evening making the news up.

- [ ] Headland at dawn.
- [ ] Look for any further report.

Previous: [[journal/day-3644]].`,
  }),
  entry({
    day: 3646,
    date: "2026-07-06",
    place: "Ogygia, the headland",
    tags: ["ogygia", "telemachus", "danger"],
    people: ["person:telemachus", "person:nestor", "person:menelaus", "person:antinous"],
    places: ["place:ogygia", "place:pylos", "place:ithaca"],
    summary: "Two reports: my son is safe at Pylos and gone on to Sparta, and the suitors have a ship waiting in the strait to kill him on his way home.",
    links: ["journal/day-3645.md", "people/telemachus.md", "people/nestor.md", "people/menelaus.md", "people/antinous.md", "omens/day-3646-hawk.md", "omens/_index.md", "people/peisistratus.md", "ithaca/suitors/ambush-ship.md", "people/athena.md"],
    body: `Two reports today, and I am writing them in the order they came.

The first: [[people/telemachus]] reached Pylos at dawn three days ago and [[people/nestor]] took him in. Nestor could not tell him where I am, and has sent him on overland by chariot to [[people/menelaus]] at Sparta, with one of his own sons, [[people/peisistratus]], driving. The report carried a sign seen at Pylos: a hawk crossing to the right of the ship, carrying, and letting nothing fall. I have filed it as [[omens/day-3646-hawk]], without an interpretation, by the rule in [[omens/_index]].

The second is the worst report yet. The suitors found out the boy had gone. [[people/antinous]] has taken a fast ship and twenty men and put them in the strait between Ithaca and Same, by the small island there, Asteris, with its double harbour. They are waiting for him to come back from Sparta. They mean to kill him on the water ([[ithaca/suitors/ambush-ship]]).

I spent the rest of the day on the headland with it. There is nothing on the sea between here and there that I can put a hand to. I cannot warn him. I cannot pray to the one god whose sea it is. So I have written it all down, every name and place, and I have prayed to [[people/athena]], out loud, for the first time in years. Not for me. For him.

Writing here what I would not write in the omen file: a bird that carries and does not let go is the kind of thing a man who has just heard his son is in danger will make too much of. So I am not making anything of it.

Previous: [[journal/day-3645]].`,
  }),
  entry({
    day: 3647,
    date: "2026-07-07",
    place: "Ogygia",
    tags: ["ogygia", "hermes", "oaths"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Hermes came with Zeus's order. She is to let me go. I made her swear she means no harm by it, and she did.",
    links: ["journal/day-3646.md", "people/calypso.md", "oaths/calypso-no-harm.md", "oaths/_index.md", "people/hermes.md", "people/zeus.md", "ogygia/build/day-3647-the-order.md", "decisions/accept-calypso-release.md"],
    body: `The wall moved today.

I was on the headland, as usual, and did not see him come. [[people/hermes]] landed on the island this morning with an order from [[people/zeus]]: I am to be let go. Not given a ship or men; let go, to build my own way off and take my chances on the sea.

[[people/calypso]] came to find me on the headland herself ([[ogygia/build/day-3647-the-order]]), which she has never done. She told me to stop weeping, that I could cut timber and build a raft, and that she would give me bread, water and wine, and clothes, and a fair wind behind.

I did not believe her. After seven years I have earned the right not to. I said I would not set foot on a raft ([[decisions/accept-calypso-release]]) unless she swore the great oath, the one the gods cannot break, that she was not planning some further harm to me. She smiled, and said I was a rogue, and swore it. The oath is filed at [[oaths/calypso-no-harm]], under [[oaths/_index]].

Then we went down and ate, and she asked me one last time, gently, if I was sure. I said yes.

- [ ] At first light, the far-end trees. She will bring the axe.
- [ ] Do not sleep late.

Previous: [[journal/day-3646]].`,
  }),
  entry({
    day: 3648,
    date: "2026-07-08",
    place: "Ogygia, the far end",
    tags: ["ogygia", "raft", "timber"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "First build day. She brought a bronze axe and showed me the trees I have been counting for seven years. Twenty down.",
    links: ["journal/day-3647.md", "voyage/ogygia/raft.md", "voyage/ogygia/_index.md", "ogygia/build/day-3648-felling.md", "ogygia/workshop/double-axe.md", "ogygia/workshop/adze.md", "ogygia/build/timber-log.md"],
    body: `First day of the build: [[ogygia/build/day-3648-felling]].

She brought me a big bronze axe ([[ogygia/workshop/double-axe]]), double-edged, with an olive-wood handle that fitted well, and a polished adze ([[ogygia/workshop/adze]]). Then she walked me to the far end of the island and showed me the tall trees, the dry ones. I did not tell her I have been counting them for seven years. I think she knew.

Twenty trees down by evening ([[ogygia/build/timber-log]]): seven fir, seven alder, six poplar, long dead and well seasoned, so they will float high. I trimmed each one with the axe as it came down and dressed it smooth. My arms are not what they were at Troy and they will be worse tomorrow.

She stood by for part of the morning and then left me to it.

The work is written up in [[voyage/ogygia/raft]] and the project in [[voyage/ogygia/_index]]. The private note is only this: it is the first day in seven years that I have done something that gets me nearer home, and I was tired in a way I had forgotten I liked.

- [ ] Ask her for augers.
- [ ] Shape the timbers square and start fitting.

Previous: [[journal/day-3647]].`,
  }),
  entry({
    day: 3649,
    date: "2026-07-09",
    place: "Ogygia, the beach",
    tags: ["ogygia", "raft", "planks"],
    people: ["person:calypso", "person:telemachus", "person:menelaus"],
    places: ["place:ogygia", "place:sparta"],
    summary: "Second build day. Squared the timbers, bored them with her augers and fitted them together with pegs and joints.",
    links: ["journal/day-3648.md", "voyage/ogygia/raft.md", "people/telemachus.md", "people/menelaus.md", "ogygia/build/day-3649-squaring.md", "ogygia/workshop/augers.md", "ogygia/build/dimensions.md", "ithaca/news/day-3649-sparta.md"],
    body: `Second day ([[ogygia/build/day-3649-squaring]]). The timbers came down to the beach, one at a time, on rollers.

She brought augers ([[ogygia/workshop/augers]]) in the morning. I bored every timber, fitted them to each other, and fastened them with pegs and with joints cut into the edges, the way a shipwright fastens a hull. I laid the bottom out ([[ogygia/build/dimensions]]) as broad as the hull of a wide cargo ship, the kind a good builder draws round for a merchant. Wider than a raft has any need to be, but I want it to sit on the sea and not in it.

Everything is squared by line. I measured twice, which has never been how I work, and I am glad.

There was a report in the evening ([[ithaca/news/day-3649-sparta]]): [[people/telemachus]] reached Sparta four days ago, and [[people/menelaus]] told him I am alive and held on an island. He has not started back. The ship in the strait is still waiting. I can do nothing about any of it, so I went back to the pegs.

The details of the hull are in [[voyage/ogygia/raft]].

- [ ] Ribs and decking.
- [ ] Bulwarks, from willow, against the sea coming over.

Previous: [[journal/day-3648]].`,
  }),
  entry({
    day: 3650,
    date: "2026-07-10",
    place: "Ogygia, the beach",
    tags: ["ogygia", "raft", "anniversary"],
    people: ["person:calypso"],
    places: ["place:ogygia"],
    summary: "Third build day: ribs, deck and bulwarks. Seven years on the island today, and I spent it on a deck.",
    links: ["journal/day-3649.md", "voyage/ogygia/raft.md", "journal/day-1095.md", "people/calypso.md", "ogygia/build/day-3650-deck.md", "ogygia/build/bulwarks.md", "ogygia/stores/ballast.md", "ogygia/build/steering-oar.md"],
    body: `Seven years on Ogygia today. I came ashore on [[journal/day-1095]] on a keel and a mast. Today I spent the whole of the anniversary building a deck.

Third day of the build ([[ogygia/build/day-3650-deck]]). Set up the ribs close together and laid the decking across them, plank by plank, fastened along the side. Then the bulwarks ([[ogygia/build/bulwarks]]): wicker of willow branches all the way round, to keep the sea from coming over, and brushwood packed in the bottom for ballast ([[ogygia/stores/ballast]]). Fitted a steering oar ([[ogygia/build/steering-oar]]) at the stern so I can hold her straight.

It looks like a vessel now, not a pile of timber. I walked round it three times in the evening light.

[[people/calypso]] came down to the beach at dusk and looked at it for a long time. She said it was well made. Then she said it was very small for that much sea, which is also true. The raft record is [[voyage/ogygia/raft]].

The anniversary feast she made four years running has not come for the last three. This year I did not miss it.

- [ ] Mast and yard.
- [ ] The cloth for the sail; she has it cut.

Previous: [[journal/day-3649]].`,
  }),
  entry({
    day: 3651,
    date: "2026-07-11",
    place: "Ogygia, the beach",
    tags: ["ogygia", "raft", "omens"],
    people: ["person:calypso", "person:penelope"],
    places: ["place:ogygia"],
    summary: "Fourth build day: mast, yard and sail, the rigging and the levers to launch her. And a report of an eagle over my courtyard.",
    links: ["journal/day-3650.md", "people/calypso.md", "voyage/ogygia/raft.md", "omens/day-3651-eagle.md", "people/penelope.md", "journal/day-3652.md", "ogygia/build/day-3651-rigging.md", "ogygia/workshop/sail-cloth.md", "ogygia/stores/provisions-aboard.md", "studies/water-ration.md"],
    body: `Fourth and last day of the build: [[ogygia/build/day-3651-rigging]].

Stepped the mast this morning and fitted the yard to it. [[people/calypso]] brought the cloth for the sail ([[ogygia/workshop/sail-cloth]]), already cut, and I made it up myself: sewed it, bent it on, rigged the braces, the halyards and the sheets. Then I set the levers under her and worked her down on the rollers to the tide line, where she sits now. She is ready, and she has not touched the water. [[voyage/ogygia/raft]] has the full record.

In the afternoon a report came in, second-hand: an eagle over the courtyard at home, carrying a goose, crossing from the right, and twenty geese on the ground watching it go. I have filed it as [[omens/day-3651-eagle]], as an observation. It was over the courtyard of my own house, where [[people/penelope]] keeps her geese. I am not going to say what it means. I am going to say that I read it four times.

Tonight she had a skin of wine and a larger skin of water put aboard ([[ogygia/stores/provisions-aboard]]), about eighteen litres. The bread comes down in the morning, fifty-one loaves in a bag, three a day for seventeen days, with the relishes and a second skin of wine. I have counted the water against seventeen days ([[studies/water-ration]]) and it is short, and I am going anyway.

- [ ] Check every lashing at first light.
- [ ] Review the shortfall. Ask for two more jars of water, about ten litres each.
- [ ] Bear on the left hand. East of north.

Tomorrow is [[journal/day-3652]].`,
  }),
];
