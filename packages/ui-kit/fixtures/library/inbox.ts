// Library domain: inbox. See ../README.md and ./types.ts.
//
// What a brain kept for twenty years actually accumulates: captures never
// processed, voice memos transcribed as spoken, half-lists, questions to self,
// and an archive of plans that were abandoned or superseded. Some of it is
// filed in the wrong folder. The defects are deliberate and declared below.
//
// Misfiled records (written into other domains' folders by mistake, never
// moved; owned by this file):
//   journal/wine-thoughts.md        -- a journal note with no day number
//   people/the-sea.md               -- the sea, filed as a person
//   ogygia/crew-names-i-forget.md   -- a crew note filed under the island
//   knowledge/untitled.md           -- a knowledge note that never got a title
//   decisions/maybe.md              -- a question filed as a decision
//   omens/a-bird-probably.md        -- an omen not properly seen

import type { KnownIssues, LibraryDocument } from "./types.js";

export const inboxDocuments: LibraryDocument[] = [
  /* ------------------------------------------------------------ inbox: recent */
  {
    path: "inbox/voice-memo-headland-night.md",
    title: "Voice memo, headland, after dark",
    type: "voice-memo",
    created: "2026-06-30",
    updated: "2026-06-30",
    status: "transcribed",
    summary: "Spoken on the headland the night the news came that the shroud was finished.",
    tags: ["voice-memo"],
    places: ["place:ogygia"],
    body: `[voice memo, transcribed, not corrected]

cannot sleep so I came up the headland the wind is off the land again which it has been every night this week and I keep thinking if I had anything that floated I would be gone on it by now which is not true I have thought that every night for seven years and not gone

the shroud is finished that is what the news said today finished so she has nothing left to unpick and they will want an answer from her and I am here on a rock listening to [[calypso]] sing through the cave mouth down there

note for the morning ask her again about the trees no do not ask her she has said no to that before not about trees about ships she has no ships

[[penelope]] would have finished it in a year if she wanted to, that is the part

end of memo the battery is going`,
    links: ["ogygia/island/headland.md", "ithaca/news/day-3640-shroud-finished.md"],
  },
  {
    path: "inbox/remember-the-skin.md",
    title: "check the skin seam",
    type: "reminder",
    created: "2026-07-11",
    updated: "2026-07-11",
    tags: ["todo", "raft"],
    body: `Check the seam at the neck of the water skin again before the tide. It wept a little at the fourth spring. See [[ogygia/stores/water]].`,
    links: ["ogygia/stores/water.md"],
  },
  {
    path: "inbox/reminder-about-a-reminder.md",
    title: "There was a reminder",
    type: "reminder",
    created: "2026-07-09",
    updated: "2026-07-10",
    tags: [],
    body: `There was a reminder set for this evening and it went off while I was pegging the planks and I dismissed it without reading it.

Something about the augers? Or about asking her something. Possibly [[inbox/ask-her-about-the-augers]].

Next day: it was the augers. Leaving this here so I remember that I forget.`,
    links: ["inbox/ask-her-about-the-augers.md"],
  },
  {
    path: "inbox/ask-her-about-the-augers.md",
    title: "Ask her about the large auger",
    type: "reminder",
    created: "2026-07-09",
    updated: "2026-07-09",
    tags: ["todo", "Tools"],
    people: ["person:calypso"],
    body: `Ask her whether the large auger was blunt before I had it. Do not assume. See [[ogygia/workshop/augers]].`,
    links: ["ogygia/workshop/augers.md"],
  },
  {
    path: "inbox/half-list-before-sleep.md",
    title: "list",
    type: "capture",
    created: "2026-07-09",
    updated: "2026-07-09",
    tags: ["raft"],
    body: `- pegs, more of them, the oak ones split
- the second auger is
- ask her for
- deck tomorrow, ribs first
- [[ogygia/build/day-3649-squaring]] write it up properly`,
    links: ["ogygia/build/day-3649-squaring.md"],
  },
  {
    path: "inbox/voice-memo-felling.md",
    title: "Voice memo, felling",
    type: "voice-memo",
    created: "2026-07-08",
    updated: "2026-07-08",
    status: "transcribed",
    summary: "Spoken while felling on the first day of the build. The count in it is not to be trusted; the timber log has the count.",
    tags: ["voice-memo", "Timber"],
    places: ["place:ogygia"],
    body: `[voice memo, transcribed, wind noise]

she showed me the stand at the end of the island the alders and the poplars and the fir that reaches the sky she says they are long dead and dry which they are you can hear it when the axe goes in

firs first then alders then the poplars last because they are nearest the beach and I want to be fresh for the long carry no that is backwards the near ones should be last anyway it does not matter

count them properly tonight do not trust this memo for the count the count is in [[ogygia/build/timber-log]]

the axe is a good axe

end`,
    links: ["ogygia/build/timber-log.md", "ogygia/build/day-3648-felling.md"],
  },
  {
    path: "inbox/distance-to-scheria.md",
    title: "Distance to Scheria",
    type: "capture",
    created: "2026-07-07",
    updated: "2026-07-10",
    status: "superseded",
    tags: ["crossing", "Distance"],
    places: ["place:ogygia", "place:scheria"],
    summary: "First figure taken down the evening of the order: 788 km to Scheria. Wrong; that is the whole way home.",
    body: `Taken down the evening Hermes came, before I had slept on any of it.

- Scheria: 788 km.
- Seventeen days.
- So about 46 km a day.

Corrected on day 3,650: 788 is the whole way to Ithaca by Scheria, not the way to Scheria. Scheria is about 632 km, so about 37 km a day, and the rest, about 156 km, is the last leg home. The worked figures are in [[studies/crossing-distance-and-margin]]. Leaving the wrong numbers here as I first wrote them, so I can see how tired I was.

The heading is the same either way: [[steering-by-the-bear]].`,
    links: ["studies/crossing-distance-and-margin.md", "voyage/legs/ogygia-to-scheria.md"],
    fields: { superseded_by: "studies/crossing-distance-and-margin.md", confidence: "wrong" },
  },
  {
    path: "inbox/water-estimate.md",
    title: "Water, by eye",
    type: "capture",
    created: "2026-07-10",
    updated: "2026-07-11",
    status: "superseded",
    tags: ["water", "stores"],
    summary: "First guess at the skin: about 15 litres by eye. Jugged the next day at about 18.",
    body: `The larger skin she gave me holds about 15 litres, by eye. Seventeen days. Under a litre a day, which is not enough for a man at an oar.

Day 3,651: filled it at the fourth spring and counted jugs. About 18, not 15. Still short. The figure that stands is in [[ogygia/stores/water]]; the ration is worked in [[studies/water-ration]].`,
    links: ["ogygia/stores/water.md", "studies/water-ration.md"],
    fields: { superseded_by: "ogygia/stores/water.md" },
  },
  {
    path: "inbox/look-into-the-tide.md",
    title: "look into: the seven o'clock tide",
    type: "capture",
    created: "2026-07-11",
    updated: "2026-07-11",
    status: "open",
    summary: "Is the seven o'clock tide the top of the water or the turn?",
    tags: ["todo"],
    body: `She says the seven o'clock tide. Look into: is that the top of it, or the turn. A raft on rollers wants the water at its highest, not leaving. [[ogygia/build/launch-way]], [[ogygia/weather/launch-window]].`,
    links: ["ogygia/build/launch-way.md", "ogygia/weather/launch-window.md"],
  },
  {
    path: "inbox/look-into-a-drogue.md",
    title: "look into: a drogue",
    type: "capture",
    created: "2026-07-10",
    updated: "2026-07-10",
    status: "open",
    tags: ["raft", "todo"],
    summary: "Would a basket on a line hold a raft head to sea in a blow?",
    body: `Look into: a basket, or the spare sail rolled, on a long line over the bow. Would it hold the raft head to sea if the wind gets up and I cannot steer? A ship lies to its anchor stones; a raft in deep water has nothing to lie to.

Started [[knowledge/drogue-from-a-basket]] and did not write it. The handling difference is in [[studies/raft-versus-ship]].`,
    links: ["studies/raft-versus-ship.md"],
  },
  {
    path: "inbox/do-not-forget-the-libation.md",
    title: "The libation",
    type: "reminder",
    created: "2026-07-12",
    updated: "2026-07-12",
    status: "open",
    summary: "Pour for the gods before the tide, and not by the old list.",
    tags: ["todo"],
    body: `Before the tide: pour for the gods, from her wine, not from the skin that goes aboard.

Which first? The old list in [[archive/gods-to-placate]] has the order wrong; it was written before Thrinacia. [[poseidon]] is the one that matters on this crossing, and he is not the one who will listen.`,
    links: ["archive/gods-to-placate.md", "knowledge/sacrifice-procedure.md"],
  },
  {
    path: "inbox/telemachus-age.md",
    title: "He is twenty",
    type: "capture",
    created: "2026-07-06",
    updated: "2026-07-06",
    status: "open",
    summary: "He is twenty. Stop writing him as the boy.",
    tags: ["ithaka"],
    people: ["person:telemachus"],
    body: `The report says he went to Pylos and spoke to Nestor himself. I keep writing him as the boy on her arm. He is twenty, or near it.

Change how I write [[telemachus]] in the file. Not "the boy". See [[ithaca/telemachus/remembered]], which is the version I have to stop using.`,
    links: ["ithaca/telemachus/remembered.md"],
  },
  {
    path: "inbox/bridge-what-i-owe.md",
    title: "Everything I owe, in one place",
    type: "capture",
    created: "2026-06-20",
    updated: "2026-07-11",
    status: "open",
    tags: ["debts", "owed"],
    people: ["person:calypso", "person:elpenor", "person:penelope", "person:teiresias"],
    summary: "Unsorted: every debt, promise and vow from the other records, gathered so I can see the size of it before I leave.",
    body: `Gathered from wherever they were filed. Not sorted. Sorting it is a job for the far side of the water.

## To the living
- To [[calypso]]: the trees, the tools, the cloth, seven years of bread. [[ogygia/debts]].
- To Penelope: what I said at the sailing ([[oaths/promise-to-penelope]]), and twenty years.
- To Maron's house: the guest-pledge ([[oaths/maron-guest-gift]]); see [[people/maron]].
- To the families: news, and the shares their men earned ([[crew/families-owed-news]], [[crew/shares-owed]]).

## To the dead
- Elpenor: done, the barrow and the oar ([[oaths/promise-to-elpenor]]).
- The rest of the six hundred: the vow at Ithaca ([[oaths/vow-to-the-dead]], [[crew/promises-to-the-dead]]).

## To the gods
- The journey inland with an oar on my shoulder, until someone calls it a winnowing fan ([[oaths/teiresias-inland-journey]]).

## Rules I keep forgetting
Gifts are not debts, or they are, depending on whom you ask ([[knowledge/guest-gifts]]). The estate is owed something too, by me, for being run without me ([[ithaca/estate]]).

> Total: I have not added it up. I am not sure it adds.`,
    links: [
      "ogygia/debts.md",
      "oaths/promise-to-penelope.md",
      "oaths/maron-guest-gift.md",
      "people/maron.md",
      "crew/families-owed-news.md",
      "crew/shares-owed.md",
      "oaths/promise-to-elpenor.md",
      "oaths/vow-to-the-dead.md",
      "crew/promises-to-the-dead.md",
      "oaths/teiresias-inland-journey.md",
      "knowledge/guest-gifts.md",
      "ithaca/estate.md",
    ],
  },
  {
    path: "inbox/bridge-the-wind-question.md",
    title: "Every wind that has mattered",
    type: "capture",
    created: "2026-06-23",
    updated: "2026-07-12",
    status: "open",
    tags: ["wind", "Wind", "crossing"],
    places: ["place:malea", "place:aeolia", "place:ogygia"],
    summary: "A ramble over every wind of the voyage, trying to work out what the one this morning means.",
    body: `Trying to put every wind in one place because I am about to need one and I want to know what kind of man I am about them.

Malea: the north wind with the current under it, nine days, and we were three days from home ([[omens/day-21-malea-wind]], [[knowledge/boreas]]). Nobody's fault and everybody's.

Aeolia: every wind but one tied in a bag ([[decisions/accept-the-bag-of-winds]], [[crew/aeolia-bag]]), and the west wind left loose ([[knowledge/zephyrus]]). Nine days on it and then I slept. The leg is [[voyage/legs/aeolia]]. I have written that one up enough.

Thrinacia: thirty days of the wrong one. I do not have a wind record for those days; the crew records have the stores ([[crew/thrinacia-provisions]]).

This crossing: the heading is east of north, which wants a wind from somewhere south or west of it. [[studies/wind-for-the-heading]] has the table. The window for it has its own record ([[ogygia/weather/launch-window]]).

There was meant to be a proper record of all of this, [[knowledge/winds-of-this-sea]]. I never wrote it. This is it, I suppose.

This morning: offshore at first light, as hoped ([[omens/day-3652-dawn-wind]]).`,
    links: [
      "omens/day-21-malea-wind.md",
      "knowledge/boreas.md",
      "decisions/accept-the-bag-of-winds.md",
      "crew/aeolia-bag.md",
      "knowledge/zephyrus.md",
      "voyage/legs/aeolia.md",
      "crew/thrinacia-provisions.md",
      "studies/wind-for-the-heading.md",
      "ogygia/weather/launch-window.md",
      "omens/day-3652-dawn-wind.md",
    ],
  },
  {
    path: "inbox/look-into-the-bear-in-july.md",
    title: "look into: does the Bear set",
    type: "capture",
    created: "2026-06-12",
    updated: "2026-06-12",
    tags: ["stars", "todo"],
    body: `Look into: does the Bear dip below the sea at all in summer, this far south? If it sets for part of the night I need something else to hold the heading by. [[knowledge/great-bear#setting]].`,
    links: ["knowledge/great-bear.md"],
  },
  {
    path: "inbox/eumaeus-reminder.md",
    title: "Swine yard first",
    type: "reminder",
    created: "2026-06-05",
    updated: "2026-06-05",
    status: "open",
    summary: "On landing, the swine yard before the hall.",
    tags: ["ithaka", "todo"],
    people: ["person:eumaeus"],
    body: `When I get home: the swine yard before the hall. [[eumaeus]] will know who can be trusted, and he will not tell anyone I asked. [[ithaca/island/eumaeus-yard]].`,
    links: ["ithaca/island/eumaeus-yard.md"],
  },
  {
    path: "inbox/photo-caption-the-gap.md",
    title: "Photo: the gap in the reef",
    type: "capture",
    created: "2026-06-03",
    updated: "2026-06-03",
    tags: ["photo"],
    body: `Photo: the gap in the reef below the cave at first light, from the rocks on the left, tide about half.

(The photo did not save; the phone was full that week. The caption is all there is.)

See [[ogygia/island/shore]].`,
    links: ["ogygia/island/shore.md"],
  },
  {
    path: "inbox/things-to-ask-penelope.md",
    title: "Things to ask Penelope",
    type: "list",
    created: "2025-11-22",
    updated: "2026-07-10",
    status: "open",
    tags: ["penelope", "questions"],
    people: ["person:penelope", "person:laertes", "person:telemachus"],
    summary: "A list kept since the news about the loom. Some of it I will never ask.",
    body: `Started the week the loom news came. Added to whenever something occurs to me at the hearth.

- Whose idea was the shroud? I think I know. Ask anyway. ([[ithaca/loom/shroud]])
- How is my father, really, not as the reports put it.
- Did my mother say anything at the end. (I know what she said to me. I want to know what she said to [[people/penelope|her]].)
- Is the olive tree still in the bedroom wall. Do not ask this one first; it will sound like a test.
- What did she tell the boy about me, and when did she stop.
- Who told the suitors about the loom. ([[ithaca/loom/discovery]].)
- The trees in the orchard he gave me as a boy: does anybody still tend them ([[orchard]]).
- Does she want me to ask any of this.

Added day 3,650: do not arrive with a list. Read it on the beach and then put the phone away.`,
    links: ["ithaca/loom/shroud.md", "ithaca/loom/discovery.md", "people/laertes.md"],
  },
  {
    path: "inbox/voice-memo-the-offer-again.md",
    title: "Voice memo",
    type: "voice-memo",
    created: "2026-07-07",
    updated: "2026-07-07",
    tags: [],
    people: ["person:calypso"],
    body: `[voice memo, transcribed]

she asked tonight whether I was sure not the offer again she has never made it again just whether I was sure and I said I was and she nodded like she had expected it and went back in to the loom

find the first time and link it

no do not link it just leave it`,
    links: [],
  },
  {
    path: "inbox/question-to-self-the-name.md",
    title: "Would I give the name again",
    type: "question",
    created: "2025-04-16",
    updated: "2025-04-16",
    status: "answered",
    tags: ["question"],
    summary: "Asked myself straight. The answer is probably yes, and I want it on record.",
    body: `Question to self, asked straight: if I were back on the stern, clear of the beach, with him throwing rocks, would I shout the name again?

Probably yes. That is the honest answer. Writing it down so that I cannot later pretend I have learned something I have not.

[[decisions/name-at-the-stern]]. And [[polyphemus]], who did nothing wrong by his own customs except the one thing.`,
    links: ["decisions/name-at-the-stern.md"],
  },
  {
    path: "inbox/suitors-count-check.md",
    title: "108?",
    type: "capture",
    created: "2025-11-04",
    updated: "2025-11-04",
    tags: ["Suitors"],
    body: `108? Check it against the islands: 52 + 24 + 20 + 12 = 108. Holds. [[ithaca/suitors/roster]].`,
    links: ["ithaca/suitors/roster.md"],
  },
  {
    path: "inbox/calypso-song-line.md",
    title: "Line from the song",
    type: "capture",
    created: "2025-07-26",
    updated: "2025-07-26",
    tags: [],
    body: `Copied down as she sang it at the loom, as near as I could get the words:

> the shuttle goes out and comes home, and the thread does not ask where

Do not know the rest. Did not ask.`,
    links: [],
  },
  {
    path: "inbox/night-headland-stars.md",
    title: "Stars, from the headland",
    type: "capture",
    created: "2026-02-10",
    updated: "2026-02-10",
    status: "inbox",
    summary: "A sleepless night on the headland, counting stars for no reason.",
    tags: ["stars"],
    body: `Up on the headland, could not sleep. Counted the Pleiades and got six again, which is what everybody gets and why there are said to be seven.

[[orion]] high in the south. The Bear wheeling round as it does, never in the water. [[knowledge/bootes]] was the one my father taught me to find first, from the Bear's tail.

Nothing to do with any of this. Wrote it down because I was up.`,
    links: ["knowledge/pleiades.md", "knowledge/bootes.md"],
  },
  {
    path: "inbox/look-into-salt-on-bread.md",
    title: "look into: bread and salt water",
    type: "capture",
    created: "2026-04-11",
    updated: "2026-04-11",
    tags: ["food"],
    body: `Does sea water ruin hard bread or only soften it? Remember the ship's bread after Malea. Look into. [[knowledge/bread-and-salt-water]], [[knowledge/sea-provisions]].`,
    links: ["knowledge/sea-provisions.md"],
  },
  {
    path: "inbox/remind-me-the-post.md",
    title: "cut the post",
    type: "reminder",
    created: "2026-05-15",
    updated: "2026-05-15",
    tags: ["routine"],
    body: `Tenth day. Cut the post. [[ogygia/routine/day-count]].`,
    links: ["ogygia/routine/day-count.md"],
  },
  {
    path: "inbox/strait-again.md",
    title: "The strait, again",
    type: "capture",
    created: "2026-03-22",
    updated: "2026-03-22",
    status: "filed",
    summary: "A dream of the strait, and a reread of the record. Nothing added.",
    tags: ["scylla"],
    body: `Dreamed of the strait. Not the six; the rowing. Everybody rowing and nobody looking up because I had not told them what was up there.

Reread [[voyage/day-1043-strait#scylla]] in the morning. Did not add anything to it. The argument about not telling them is in [[decisions/what-to-tell-the-crew]] and I am still on the same side of it.`,
    links: ["decisions/what-to-tell-the-crew.md"],
  },

  /* ------------------------------------------------------------ inbox: old, never processed */
  {
    path: "inbox/argos-one-line.md",
    title: "Argos",
    type: "capture",
    created: "2023-05-17",
    updated: "2023-05-17",
    tags: [],
    people: ["person:argos"],
    body: `Argos. Is he alive. He would be seventeen. (No report. Stop writing this.) [[people/argos]]`,
    links: ["people/argos.md"],
  },
  {
    path: "inbox/three-words.md",
    title: "three words",
    type: "capture",
    created: "2022-08-12",
    updated: "2022-08-12",
    tags: [],
    body: `salt. patience. the north.

(No idea now what these were for.)`,
    links: [],
  },
  {
    path: "inbox/question-to-self-a-ship.md",
    title: "Why have I not asked her for a ship",
    type: "question",
    created: "2019-10-25",
    updated: "2019-10-25",
    status: "answered",
    summary: "She has no ship and no men. Kept the question for the answer.",
    tags: ["question", "ogygia"],
    places: ["place:ogygia"],
    body: `Why have I not asked her for a ship?

Answered it myself while writing it: she has none, and no men to sail one. Keeping the question anyway, because it is the first thing anyone would ask me and I want the answer ready.

[[calypso]]`,
    links: ["people/calypso.md"],
  },
  {
    path: "inbox/voice-memo-thrinacia.md",
    title: "Voice memo, Thrinacia",
    type: "voice-memo",
    created: "2019-06-09",
    updated: "2019-06-09",
    status: "transcribed",
    summary: "The day the stores ran out on Thrinacia, spoken into the phone on the beach. Transcribed years later.",
    tags: ["voice-memo", "thrinacia"],
    people: ["person:eurylochus"],
    places: ["place:thrinacia"],
    body: `[voice memo, transcribed much later, the audio is mostly wind]

last of everything today the barley and the wine both gone they say they will fish tomorrow with bent hooks and take birds and I have told them again the herds are not food the herds are the god's and they swore it to me on the beach with their hands up

[[eurylochus]] did not argue today which is worse

if the wind does not change I will go inland and pray where it is quiet

[[oaths/helios]]`,
    links: ["oaths/helios.md", "crew/thrinacia-provisions.md"],
  },
  {
    path: "inbox/voice-memo-aeaea-a-year.md",
    title: "Voice memo, Aeaea",
    type: "voice-memo",
    created: "2018-02-22",
    updated: "2018-02-22",
    status: "transcribed",
    summary: "The evening the crew came to say a year on Aeaea was enough.",
    tags: ["voice-memo", "Aeaea"],
    people: ["person:circe"],
    places: ["place:aeaea"],
    body: `[voice memo, transcribed]

they came to me in a group this evening which they have never done the ones from ship one all of them and said it is time to think of home if it is our fate to see it and they are right a year near enough and I had not counted it I who count everything

I will ask [[circe]] tonight I think she will let us go she has never said she would keep us

what I did not tell them is that I had stopped wanting to`,
    links: ["decisions/stay-the-year.md", "voyage/legs/aeaea-first-stay.md"],
  },
  {
    path: "inbox/capture-the-oar.md",
    title: "Capture",
    type: "capture",
    created: "2018-06-12",
    updated: "2018-06-12",
    tags: [],
    body: `The oar on the barrow faces the sea. She said that is the right way. I had it the other way first.`,
    links: [],
  },
  {
    path: "inbox/maron-wine-how-much-left.md",
    title: "Maron's wine, check",
    type: "reminder",
    created: "2016-10-21",
    updated: "2016-10-21",
    status: "open",
    summary: "Check what is left of Maron's wine after the cave, and keep it out of the ration.",
    tags: ["todo", "Wine"],
    body: `Check how much of Maron's wine is left after the cave. Do not let it into the general ration; it is not a drinking wine, it is a weapon. [[knowledge/maron-wine-strength]], [[crew/ismarus-wine-ration]].`,
    links: ["crew/ismarus-wine-ration.md"],
  },
  {
    path: "inbox/sails-running-count.md",
    title: "Sails, running count",
    type: "capture",
    created: "2024-05-31",
    updated: "2024-05-31",
    status: "superseded",
    tags: ["ships", "count"],
    summary: "Running total copied out on day 2,880: 39 sails. The count closed later at 41.",
    body: `Running count of sails seen from the headland, copied out here because the sightings record would not open that morning.

- Total to day 2,880: 39.
- Closest: horizon, as always.

The count did not stop at 39. Two more before I stopped counting in the fifth year; the closed figure, 41, is in [[ogygia/island/sightings]].`,
    links: ["ogygia/island/sightings.md"],
    fields: { superseded_by: "ogygia/island/sightings.md", count: 39 },
  },

  /* ------------------------------------------------------------ archive */
  {
    path: "archive/plan-take-a-ship.md",
    title: "Plan: take a ship from passing traders",
    type: "plan",
    created: "2019-09-05",
    updated: "2026-07-07",
    status: "abandoned",
    tags: ["plan", "ogygia", "ships"],
    places: ["place:ogygia"],
    summary: "Year one: wait on the headland for traders to water at the island, and take passage or the ship. No ship ever came close enough.",
    body: `Written in the first months, when I still thought the island was on somebody's way.

## The plan
1. Watch from the headland at first light for sails ([[ogygia/island/headland]]).
2. Any ship that comes in to water will use the springs below the cave. Be there first.
3. Ask for passage as a suppliant. If refused, wait for the night and take the ship.

## What was wrong with it
- Step 3 breaks guest-right twice over: theirs on the beach, hers on the island ([[knowledge/guest-friendship]]). I wrote it anyway.
- No ship came in. Forty-one sails in five years, none nearer than the horizon ([[ogygia/island/sightings]]).
- I had marked where I thought the traders' route ran in [[archive/traders-route-guess]]. I never wrote that record either.

## Abandoned
Day 1,400. Not formally; I stopped opening it. The decision that replaced it, seven years later, was to build ([[decisions/build-rather-than-wait]]).`,
    links: ["ogygia/island/headland.md", "knowledge/guest-friendship.md", "ogygia/island/sightings.md", "decisions/build-rather-than-wait.md"],
  },
  {
    path: "archive/raft-design-year-3.md",
    title: "Raft, first design",
    type: "design",
    created: "2021-09-24",
    updated: "2026-07-11",
    status: "abandoned",
    tags: ["raft", "design"],
    places: ["place:ogygia"],
    summary: "Drawn in year three on the phone. Sound enough; abandoned because I had no axe, no adze and no auger, and would not ask.",
    body: `Drawn in year three, on the phone, from memory of ships and from walking the woods.

## The design
- Broad bottom, the beam of a merchantman, logs laid side by side and pinned.
- Ribs across, a deck over them.
- A fence of wicker along both sides against the sea.
- A mast and yard, a steering oar.

## Timber
Walked the stand at the island's end: fir, alder and poplar, long dead and dry. Enough. See [[ogygia/island/woods]].

## Why it stopped
I have no tools: no axe, no adze, no auger. Asking her for the tools meant asking her to help me leave, and I would not ask. Abandoned day 1,950.

## Afterward
Most of it was built four years later, with her tools and on her offer, in four days ([[raft]]). The year it was drawn: [[ogygia/years/year-3]]. The method is in [[knowledge/raft-construction]].`,
    links: ["ogygia/island/woods.md", "ogygia/years/year-3.md", "knowledge/raft-construction.md"],
  },
  {
    path: "archive/letter-to-penelope-unsent.md",
    title: "Letter to Penelope (draft, not sent)",
    type: "draft",
    created: "2023-02-16",
    updated: "2023-02-16",
    status: "abandoned",
    tags: ["penelope", "letter", "draft"],
    people: ["person:penelope", "person:telemachus"],
    summary: "Written the week the first news came. There was no way to send it, and I knew that while I wrote it.",
    body: `Written the week the first news of any kind came from Ithaca. There is no way to send it. I wrote it anyway.

---

You will have heard nothing, or worse than nothing. I am alive. I am on an island a long way off across the sea, and I cannot leave it, and I will not tell you the reason in a letter because it would sound like an excuse and it is not one.

The men are gone. All of them. I will tell their families myself.

Whatever you have decided, you were right to decide it. I said at the sailing that if I did not come back by the time the boy had a beard you should do what you thought best ([[ithaca/departure-instructions]]). I meant it then. I find I do not mean it now, and that is mine to carry, not yours.

---

Stopped there. Read it back and it was a letter asking [[people/penelope|her]] to wait, dressed as one telling her not to. Not sent; there is nothing to send it with. Kept, because it is the truest thing I wrote that year. What I actually promised: [[oaths/promise-to-penelope]].`,
    links: ["ithaca/departure-instructions.md", "oaths/promise-to-penelope.md"],
  },
  {
    path: "archive/crew-ledger-before-the-recount.md",
    title: "Crew ledger, as of the Laestrygonian night (before the recount)",
    type: "ledger",
    created: "2017-02-02",
    updated: "2017-02-03",
    status: "superseded",
    tags: ["ledger", "Crew"],
    places: ["place:laestrygonians"],
    summary: "Written in the dark after the harbour with a guessed figure. The recount the next morning made it 484.",
    body: `Written that night, on ship 1, rowing, with nothing but a guess.

| | Ships | Men |
|---|---|---|
| Sailed from Troy | 12 | 600 |
| After Ismarus | 12 | 528 |
| After the cave | 12 | 522 |
| Lost tonight | 11 | about 480? |
| Aboard ship 1 | 1 | 38 |

---

Next morning, the recount: every one of the eleven had sailed out of the cave country with 44 aboard. 11 times 44 is 484, not "about 480". The guess was mine, the arithmetic was not hard, and I got it wrong because I would not do it that night. The figure that stands is in [[crew/fleet-strength]] and the morning roll call in [[crew/roll-calls/day-206]].

Kept as it was written. Do not correct the table above.`,
    links: ["crew/fleet-strength.md", "crew/roll-calls/day-206.md", "crew/losses/laestrygonians.md"],
    fields: { superseded_by: "crew/fleet-strength.md", day: 205 },
  },
  {
    path: "archive/winds-before-the-split.md",
    title: "Winds (split into four)",
    type: "redirect",
    created: "2019-08-06",
    updated: "2020-09-09",
    status: "superseded",
    tags: ["wind", "renamed"],
    summary: "The old single record on winds, split into one per wind. The old links into it now point nowhere.",
    body: `This was the one record on winds, kept from the voyage. In year two I split it into one record per wind and moved the heading notes into the studies, and this stub is what is left.

Now:
- [[knowledge/boreas]]
- [[knowledge/notus]]
- [[knowledge/eurus]]
- [[knowledge/zephyrus]]

Old names that other notes still use, and which no longer exist: [[knowledge/winds]] and [[studies/heading-north-east]]. I did not chase the old links down. Somebody should.`,
    links: ["knowledge/boreas.md", "knowledge/notus.md", "knowledge/eurus.md", "knowledge/zephyrus.md", "knowledge/winds.md"],
  },
  {
    path: "archive/signal-from-the-headland.md",
    title: "Plan: signal from the headland",
    type: "plan",
    created: "2019-08-06",
    updated: "2021-07-11",
    status: "abandoned",
    tags: ["plan", "signal"],
    places: ["place:ogygia"],
    summary: "Build the hearth fire up whenever a sail shows. Tried four times in two years. No ship turned.",
    body: `## Plan
- Keep dry wood stacked by the hearth at all times ([[ogygia/island/hearth]]).
- When a sail shows from the headland, run down and build the fire up for smoke.
- Second fire on the headland itself if I can carry the wood up in time.

## Result
Built up four times in the first two years. No ship turned. The headland fire was never lit: by the time I had carried anything up, the sail was gone.

## Why abandoned
The island is not on anybody's way to anywhere. I stopped building the fire for sails at the end of year two. Count of sails: [[ogygia/island/sightings]].

She saw the smoke every time and said nothing. [[calypso]]`,
    links: ["ogygia/island/hearth.md", "ogygia/island/sightings.md"],
  },
  {
    path: "archive/gods-to-placate.md",
    title: "Gods to placate, in order",
    type: "list",
    created: "2018-03-29",
    updated: "2019-07-17",
    status: "superseded",
    tags: ["gods", "sacrifice"],
    people: ["person:poseidon", "person:athena"],
    summary: "Drawn up on Aeaea before the house of the dead. The order was wrong by Thrinacia, and the list was not touched again.",
    body: `Drawn up on Aeaea after we came back from the dead, to decide where the offerings go first. Out of date: see the note at the end.

| Order | God | Why | Owed |
|---|---|---|---|
| 1 | Poseidon | The cave. He holds it ([[people/poseidon]]). | Everything |
| 2 | Aeolus | Turned us away; may yet relent | A ram |
| 3 | Athena | Silent since Troy ([[knowledge/athena-favour]]) | Thigh pieces, often |
| 4 | Zeus | Guest-right | The usual |
| 5 | Helios | None owed | -- |

---

Updated on Ogygia, day 1,100: Helios is not fifth. Helios was owed a whole ship, and has had it ([[knowledge/thrinacia-cattle]]). Aeolus will not relent; he said so ([[decisions/return-to-aeolus]]). I have not redrawn the list because every order I try ends with the same god at the top. The method is unchanged: [[knowledge/sacrifice-procedure]].`,
    links: ["people/poseidon.md", "knowledge/athena-favour.md", "knowledge/thrinacia-cattle.md", "decisions/return-to-aeolus.md", "knowledge/sacrifice-procedure.md"],
  },
  {
    path: "archive/water-ration-v1.md",
    title: "Water ration, first version",
    type: "plan",
    created: "2026-07-08",
    updated: "2026-07-11",
    status: "superseded",
    tags: ["water", "ration"],
    summary: "An even ration over seventeen days from one skin, before the skin was measured and before the shortfall was opened.",
    body: `First version, written the morning of the felling.

- One skin. Call it 15 litres.
- Seventeen days, even ration: under a litre a day.
- Drink at dawn and at dusk only.

Superseded twice: the skin is about 18 by the jug, not 15 ([[inbox/water-estimate]]), and an even ration is the wrong shape for a crossing where the hard days come first. The current working is [[studies/water-ration]]; the open question is on [[ogygia/stores/water]].`,
    links: ["inbox/water-estimate.md", "studies/water-ration.md", "ogygia/stores/water.md"],
  },
  {
    path: "archive/day-count-cuts-year-1.md",
    title: "Post cuts, year one (before the recount)",
    type: "ledger",
    created: "2020-07-11",
    updated: "2020-08-20",
    status: "superseded",
    tags: ["calendar"],
    summary: "The year-one tally of cuts on the cave post, one short of the phone. The phone was right.",
    body: `Tally of the cuts on the cedar post at the end of the first year on the island:

- Cuts: 35.
- Expected, at one every tenth day from landfall: 36.

One short. For a month I thought the phone had drifted. Recounted against the journal: I had missed a cut in the weeks I was ill, and the phone was right all along. The method and the later checks are in [[ogygia/routine/day-count]].`,
    links: ["ogygia/routine/day-count.md"],
  },

  /* ------------------------------------------------------------ misfiled */
  {
    path: "journal/wine-thoughts.md",
    title: "wine thoughts",
    type: "note",
    created: "2021-06-02",
    updated: "2026-07-11",
    status: "draft",
    summary: "Every wine on the voyage has done something. A note with no day number, filed in the journal by mistake.",
    tags: ["Wine", "wine"],
    body: `No day number on this because I started it as a note and filed it here by mistake, and then kept adding to it here.

Every wine on this voyage has done something. Ismarus: the men would not leave it, and seventy-two did not leave at all ([[crew/ismarus-wine-ration]]). Maron's: twenty measures of water to one and still the strongest thing I have drunk; it put a Cyclops to sleep ([[knowledge/maron-wine-strength]]). Aeaea: her wine had the drug in it, which is a thing I check now in every cup and do not say so.

Here: her wine is good and I drink it mixed, and I have never once been drunk on this island, which I notice because I could have been every night.

Aboard for the crossing: one skin of her wine. A second offered and not yet carried down. [[ogygia/stores/wine]].`,
    links: ["crew/ismarus-wine-ration.md", "ogygia/stores/wine.md", "knowledge/circe-drugs.md"],
  },
  {
    path: "people/the-sea.md",
    title: "The sea",
    type: "person",
    created: "2020-01-14",
    updated: "2025-12-01",
    status: "draft",
    summary: "The sea is not Poseidon. Filed under people by mistake, and kept there.",
    tags: ["sea", "Sea"],
    body: `Filed under people because that is where I was when I wrote it, and because some nights it is the right folder.

The sea is not Poseidon. Poseidon is a god with a grievance and a name ([[people/poseidon]]). The sea is what he works in. It does not hate me. It does not notice me. On a calm morning off the shore I can forget the difference.

Things it has done: Malea, nine days; the strait; the storm off Thrinacia; nine days on a keel and a mast. Things it has not done: kill me. I do not know which list is longer by the reckoning that matters.

[[knowledge/poseidon-at-sea]] has the working version. This is the other one.`,
    links: ["people/poseidon.md", "knowledge/poseidon-at-sea.md"],
  },
  {
    path: "ogygia/crew-names-i-forget.md",
    title: "Names I am losing",
    type: "note",
    created: "2024-03-03",
    updated: "2026-06-14",
    status: "open",
    tags: ["Crew"],
    summary: "Men from ship 1 whose faces I have and whose names I do not. Filed here because I wrote it on the shore.",
    body: `Meant for the crew register. Written on the shore and saved here, and I have not moved it.

The ones I can name: [[crew/polites]], [[perimedes]], Eurylochus, Elpenor, Antiphus. The rest of ship 1 I have by face and by bench.

- The bow oar who sang on the long pulls. I had a record for him, [[crew/ship-1-bow-oar]], or I meant to.
- The one who mended nets on the beach at Aeaea and never once asked me when we were going.
- Two brothers on the steering side, ship 1, from the north of the island.
- The man who held the stake with me in the cave and would not take the share I offered for it.

I said their names three times at every stern. I have lost them anyway. Their families are on [[crew/families-owed-news]] by ship and bench, which will have to do.`,
    links: ["crew/polites.md", "crew/families-owed-news.md", "crew/register.md"],
  },
  {
    path: "knowledge/untitled.md",
    title: "untitled",
    type: "note",
    created: "2023-09-30",
    updated: "2023-09-30",
    tags: [],
    body: `Currents east of the island: on calm days the weed off the shore drifts north-east. Start of a note, see [[knowledge/currents-east-of-ogygia]].`,
    links: [],
  },
  {
    path: "decisions/maybe.md",
    title: "Maybe: the second skin of wine",
    type: "note",
    created: "2026-07-11",
    updated: "2026-07-11",
    tags: ["todo"],
    people: ["person:calypso"],
    body: `Not a decision. Filed here because I opened the wrong folder.

Carry down the second skin of wine [[calypso]] offered last night, or leave it and go with what is aboard. One skin is aboard. The second is at the cave. Weight against need; I have not decided. [[ogygia/stores/wine]].`,
    links: ["ogygia/stores/wine.md"],
  },
  {
    path: "omens/a-bird-probably.md",
    title: "a bird, probably",
    type: "omen",
    created: "2026-02-28",
    updated: "2026-02-28",
    tags: ["omen?"],
    body: `Something crossed on the left over the meadows at dusk, low and fast, and was gone into the alders before I could see what it was carrying, if anything. A bird, probably. Did not see it well enough to file it properly. Compare [[omens/heron-in-the-dark]], which I also did not see.`,
    links: ["omens/heron-in-the-dark.md"],
  },
];

export const inboxKnownIssues: KnownIssues = {
  unresolved: [
    ["inbox/look-into-a-drogue.md", "knowledge/drogue-from-a-basket.md"],
    ["inbox/bridge-the-wind-question.md", "knowledge/winds-of-this-sea.md"],
    ["inbox/look-into-salt-on-bread.md", "knowledge/bread-and-salt-water.md"],
    ["inbox/maron-wine-how-much-left.md", "knowledge/maron-wine-strength.md"],
    ["journal/wine-thoughts.md", "knowledge/maron-wine-strength.md"],
    ["archive/plan-take-a-ship.md", "archive/traders-route-guess.md"],
    ["archive/winds-before-the-split.md", "knowledge/winds.md"],
    ["archive/winds-before-the-split.md", "studies/heading-north-east.md"],
    ["ogygia/crew-names-i-forget.md", "crew/ship-1-bow-oar.md"],
    ["knowledge/untitled.md", "knowledge/currents-east-of-ogygia.md"],
  ],
  // knowledge/untitled.md links only to a note never written, so in the graph
  // it has no edge at all: an orphan, as the maintenance view counts them.
  orphans: ["inbox/calypso-song-line.md", "inbox/three-words.md", "inbox/capture-the-oar.md", "inbox/voice-memo-the-offer-again.md", "knowledge/untitled.md"],
};
