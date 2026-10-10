// The folder indexes. Every domain links up to its hub, and each hub links up
// to the goal and down to every record in its folder, so nothing in the
// library is stranded or unreachable. The lists are written out in full, not
// computed: regenerate them by hand when a folder's records change.

import type { LibraryDocument } from "./types.js";

export const hubs: LibraryDocument[] = [
  {
    path: "people/_index.md",
    title: "People",
    type: "index",
    created: "2017-02-14",
    updated: "2025-11-03",
    status: "active",
    tags: ["index"],
    summary: "Everyone the voyage has met, owes or lost, by standing.",
    body: `The people Odysseus has dealt with since Troy, and the household he left. A record notes what is known and when it was last true; it is not a channel to anyone.

28 records, as of the last revision.

## Records

- [[people/achilles]] — Achilles
- [[people/aegyptius]] — Aegyptius
- [[people/anticleia]] — Anticleia
- [[people/antinous]] — Antinous
- [[people/calchas]] — Calchas
- [[people/calypso]] — Calypso
- [[people/diomedes]] — Diomedes
- [[people/dolius]] — Dolius
- [[people/eupeithes]] — Eupeithes
- [[people/eurymachus]] — Eurymachus
- [[people/halitherses]] — Halitherses
- [[people/helen]] — Helen
- [[people/heracles]] — Heracles
- [[people/leiocritus]] — Leiocritus
- [[people/melanthius]] — Melanthius
- [[people/menelaus]] — Menelaus
- [[people/mentor]] — Mentor
- [[people/nestor]] — Nestor
- [[people/orestes]] — Orestes
- [[people/palamedes]] — Palamedes
- [[people/patroclus]] — Patroclus
- [[people/peleus]] — Peleus
- [[people/philoctetes]] — Philoctetes
- [[people/polyphemus]] — Polyphemus
- [[people/sisyphus]] — Sisyphus
- [[people/teiresias]] — Teiresias
- [[people/thoosa]] — Thoosa
- [[people/zeus]] — Zeus

## Other indexes

[[decisions/_index]] · [[ithaca/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","people/achilles.md","people/aegyptius.md","people/anticleia.md","people/antinous.md","people/calchas.md","people/calypso.md","people/diomedes.md","people/dolius.md","people/eupeithes.md","people/eurymachus.md","people/halitherses.md","people/helen.md","people/heracles.md","people/leiocritus.md","people/melanthius.md","people/menelaus.md","people/mentor.md","people/nestor.md","people/orestes.md","people/palamedes.md","people/patroclus.md","people/peleus.md","people/philoctetes.md","people/polyphemus.md","people/sisyphus.md","people/teiresias.md","people/thoosa.md","people/zeus.md","decisions/_index.md","ithaca/_index.md"],
  },
  {
    path: "knowledge/_index.md",
    title: "Knowledge",
    type: "index",
    created: "2018-05-02",
    updated: "2024-02-19",
    status: "active",
    tags: ["index"],
    summary: "What the voyage has learned about the sea, the gods and the hazards between.",
    body: `Hazards, gods, winds, stars and the practical knowledge of keeping a ship alive. Entries record what was told, by whom, and whether it proved true.

32 records, as of the last revision.

## Records

- [[knowledge/athena-favour]] — Athena's favour
- [[knowledge/bailing]] — Bailing
- [[knowledge/beaching]] — Beaching a ship
- [[knowledge/bootes]] — Boötes
- [[knowledge/circe-drugs]] — Circe's drugs
- [[knowledge/cyclopes-customs]] — The Cyclopes' customs
- [[knowledge/cyclops-door-stone]] — The stone across the cave
- [[knowledge/fevers]] — Fevers and thirst
- [[knowledge/great-bear]] — The Great Bear
- [[knowledge/guest-gifts]] — Guest-gifts
- [[knowledge/hermes]] — Hermes
- [[knowledge/lotus]] — The lotus
- [[knowledge/mast-stepping]] — Stepping and lowering the mast
- [[knowledge/moly]] — Moly
- [[knowledge/mooring]] — Mooring stones and stern cables
- [[knowledge/notus]] — Notus, the south wind
- [[knowledge/oar-counts]] — Oars and men
- [[knowledge/order-of-the-shades]] — The order of the shades
- [[knowledge/orion]] — Orion
- [[knowledge/poseidon-at-sea]] — Poseidon, as he bears on a sailor
- [[knowledge/reading-a-coast]] — Reading a coast
- [[knowledge/rites-for-the-dead]] — The rites for the dead
- [[knowledge/sacrifice-procedure]] — Sacrifice procedure
- [[knowledge/scylla]] — Scylla
- [[knowledge/sea-provisions]] — Provisions that keep at sea
- [[knowledge/sirens]] — Sirens
- [[knowledge/suppliants]] — Supplication
- [[knowledge/teiresias-forecast]] — The forecast
- [[knowledge/thrinacia-cattle]] — The cattle of Helios
- [[knowledge/watering-parties]] — Watering parties
- [[knowledge/wounds]] — Wounds
- [[knowledge/zephyrus]] — Zephyrus, the west wind

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","knowledge/athena-favour.md","knowledge/bailing.md","knowledge/beaching.md","knowledge/bootes.md","knowledge/circe-drugs.md","knowledge/cyclopes-customs.md","knowledge/cyclops-door-stone.md","knowledge/fevers.md","knowledge/great-bear.md","knowledge/guest-gifts.md","knowledge/hermes.md","knowledge/lotus.md","knowledge/mast-stepping.md","knowledge/moly.md","knowledge/mooring.md","knowledge/notus.md","knowledge/oar-counts.md","knowledge/order-of-the-shades.md","knowledge/orion.md","knowledge/poseidon-at-sea.md","knowledge/reading-a-coast.md","knowledge/rites-for-the-dead.md","knowledge/sacrifice-procedure.md","knowledge/scylla.md","knowledge/sea-provisions.md","knowledge/sirens.md","knowledge/suppliants.md","knowledge/teiresias-forecast.md","knowledge/thrinacia-cattle.md","knowledge/watering-parties.md","knowledge/wounds.md","knowledge/zephyrus.md"],
  },
  {
    path: "studies/_index.md",
    title: "Studies",
    type: "index",
    created: "2021-01-09",
    updated: "2026-06-02",
    status: "active",
    tags: ["index"],
    summary: "Longer pieces of reading and reasoning, kept for the crossing.",
    body: `Navigation, weather and seamanship, worked through at length. Shorter facts live in knowledge.

2 records, as of the last revision.

## Records

- [[studies/july-weather]] — July weather on this sea
- [[studies/losses-by-hazard]] — Six hundred, by cause

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","studies/july-weather.md","studies/losses-by-hazard.md"],
  },
  {
    path: "journal/_index.md",
    title: "Journal",
    type: "index",
    created: "2016-07-22",
    updated: "2023-05-30",
    status: "active",
    tags: ["index"],
    summary: "One entry per day since Troy fell, numbered from that day.",
    body: `Entries are named by the day count since Troy fell: day 1 is the morning after. Day 3652 is today.

23 records, as of the last revision.

## Records

- [[journal/day-10]] — Day 10
- [[journal/day-97]] — Day 97
- [[journal/day-100]] — Day 100
- [[journal/day-172]] — Day 172
- [[journal/day-430]] — Day 430
- [[journal/day-621]] — Day 621
- [[journal/day-1044]] — Day 1,044
- [[journal/day-1090]] — Day 1,090
- [[journal/day-1095]] — Day 1,095
- [[journal/day-1096]] — Day 1,096
- [[journal/day-1098]] — Day 1,098
- [[journal/day-1102]] — Day 1,102
- [[journal/day-1110]] — Day 1,110
- [[journal/day-1130]] — Day 1,130
- [[journal/day-1180]] — Day 1,180
- [[journal/day-1300]] — Day 1,300
- [[journal/day-1460]] — Day 1,460
- [[journal/day-1575]] — Day 1,575
- [[journal/day-1576]] — Day 1,576
- [[journal/day-1600]] — Day 1,600
- [[journal/day-2000]] — Day 2,000
- [[journal/day-2400]] — Day 2,400
- [[journal/wine-thoughts]] — wine thoughts

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","journal/day-10.md","journal/day-97.md","journal/day-100.md","journal/day-172.md","journal/day-430.md","journal/day-621.md","journal/day-1044.md","journal/day-1090.md","journal/day-1095.md","journal/day-1096.md","journal/day-1098.md","journal/day-1102.md","journal/day-1110.md","journal/day-1130.md","journal/day-1180.md","journal/day-1300.md","journal/day-1460.md","journal/day-1575.md","journal/day-1576.md","journal/day-1600.md","journal/day-2000.md","journal/day-2400.md","journal/wine-thoughts.md"],
  },
  {
    path: "decisions/_index.md",
    title: "Decisions",
    type: "index",
    created: "2017-11-20",
    updated: "2025-04-12",
    status: "active",
    tags: ["index"],
    summary: "Every choice that cost something, with what it cost.",
    body: `A decision record states the options, the choice, the cost and what is still worth reviewing. Closed decisions stay closed; the questions they leave stay open.

17 records, as of the last revision.

## Records

- [[decisions/accept-the-bag-of-winds]] — Accept the bag of winds
- [[decisions/blind-rather-than-kill]] — Blind him rather than kill him
- [[decisions/cattle-of-helios]] — The cattle on Thrinacia
- [[decisions/cut-the-cable]] — Cut the cable and row
- [[decisions/drag-back-the-lotus-eaters]] — Drag the lotus-eaters back to the ships
- [[decisions/go-to-the-dead]] — Go to the house of the dead
- [[decisions/hear-the-sirens]] — Hear the Sirens, bound
- [[decisions/hold-the-fig-tree]] — Hold the fig tree
- [[decisions/keep-the-helm-nine-days]] — Keep the helm nine days and sleep on the tenth
- [[decisions/name-at-the-stern]] — Giving the name at the stern
- [[decisions/nobody-as-the-name]] — Give the name as Nobody
- [[decisions/raid-ismarus]] — Raid Ismarus
- [[decisions/refuse-immortality]] — Refuse immortality
- [[decisions/stay-the-year]] — Stay the year on Aeaea
- [[decisions/wait-for-polyphemus]] — Wait for the owner of the cave
- [[decisions/wait-out-the-seasons]] — Wait out the seasons on Aeaea
- [[decisions/what-to-tell-the-crew]] — Tell the crew about the Sirens, not about Scylla

## Other indexes

[[people/_index]] · [[ithaca/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","decisions/accept-the-bag-of-winds.md","decisions/blind-rather-than-kill.md","decisions/cattle-of-helios.md","decisions/cut-the-cable.md","decisions/drag-back-the-lotus-eaters.md","decisions/go-to-the-dead.md","decisions/hear-the-sirens.md","decisions/hold-the-fig-tree.md","decisions/keep-the-helm-nine-days.md","decisions/name-at-the-stern.md","decisions/nobody-as-the-name.md","decisions/raid-ismarus.md","decisions/refuse-immortality.md","decisions/stay-the-year.md","decisions/wait-for-polyphemus.md","decisions/wait-out-the-seasons.md","decisions/what-to-tell-the-crew.md","people/_index.md","ithaca/_index.md"],
  },
  {
    path: "oaths/_index.md",
    title: "Oaths",
    type: "index",
    created: "2018-09-03",
    updated: "2022-10-01",
    status: "active",
    tags: ["index"],
    summary: "Oaths sworn, received and broken, and who holds each one.",
    body: `An oath is recorded with who swore it, by what, and its standing today.

12 records, as of the last revision.

## Records

- [[oaths/circe-no-harm]] — Circe's oath on Aeaea
- [[oaths/helios]] — Oath sworn on Thrinacia
- [[oaths/maron-guest-gift]] — Pledge with Maron at Ismarus
- [[oaths/polyphemus-curse]] — Polyphemus's prayer to Poseidon
- [[oaths/promise-to-elpenor]] — Promise to Elpenor
- [[oaths/promise-to-penelope]] — What I promised Penelope at the sailing
- [[oaths/sirens-binding-order]] — The order at the mast
- [[oaths/teiresias-inland-journey]] — The journey inland with an oar
- [[oaths/tyndareus-oath]] — The oath of Helen's suitors
- [[oaths/vow-to-the-dead]] — Vow to the dead, owed at Ithaca
- [[oaths/xenia-aeolus]] — Guest-friendship of Aeolus
- [[oaths/xenia-polyphemus]] — Guest-right claimed in the cave

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","oaths/circe-no-harm.md","oaths/helios.md","oaths/maron-guest-gift.md","oaths/polyphemus-curse.md","oaths/promise-to-elpenor.md","oaths/promise-to-penelope.md","oaths/sirens-binding-order.md","oaths/teiresias-inland-journey.md","oaths/tyndareus-oath.md","oaths/vow-to-the-dead.md","oaths/xenia-aeolus.md","oaths/xenia-polyphemus.md"],
  },
  {
    path: "omens/_index.md",
    title: "Omens",
    type: "index",
    created: "2019-12-24",
    updated: "2026-07-02",
    status: "active",
    tags: ["index"],
    summary: "Signs observed, with what each was taken to mean and whether it held.",
    body: `An omen is logged as an observation first and an interpretation second. Birds are described by what they were doing.

8 records, as of the last revision.

## Records

- [[omens/a-bird-probably]] — a bird, probably
- [[omens/day-21-malea-wind]] — North wind and current at Malea
- [[omens/day-99-ram-refused]] — The ram on the beach, not accepted
- [[omens/day-172-aeolus-reading]] — Aeolus reads the return
- [[omens/day-246-the-stag]] — The stag on the path
- [[omens/day-1041-calm]] — A calm before the Sirens
- [[omens/day-1078-hides-crawled]] — The hides crawled
- [[omens/heron-in-the-dark]] — Heron on the right, at night

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","omens/a-bird-probably.md","omens/day-21-malea-wind.md","omens/day-99-ram-refused.md","omens/day-172-aeolus-reading.md","omens/day-246-the-stag.md","omens/day-1041-calm.md","omens/day-1078-hides-crawled.md","omens/heron-in-the-dark.md"],
  },
  {
    path: "ithaca/_index.md",
    title: "Ithaca",
    type: "index",
    created: "2020-04-17",
    updated: "2026-03-21",
    status: "active",
    tags: ["index"],
    summary: "The household, the estate and the island, as far as news reaches.",
    body: `What is known of home: the household, the herds, the hall and the island. News is dated by when it arrived, not when it happened.

17 records, as of the last revision.

## Hall

- [[ithaca/hall/daily-pattern]] — A day in the hall, as reported

## Records

- [[ithaca/homecoming-checklist]] — Homecoming checklist
- [[ithaca/reported-and-remembered]] — Reported and remembered

## Household

- [[ithaca/household/eurycleia]] — Eurycleia
- [[ithaca/household/phemius]] — Phemius, the singer

## Island

- [[ithaca/island/arethusa]] — The spring Arethusa
- [[ithaca/island/laertes-farm]] — My father's farm
- [[ithaca/island/neriton]] — Mount Neriton
- [[ithaca/island/philoetius-cattle]] — Philoetius and the cattle
- [[ithaca/island/ravens-rock]] — Raven's Rock

## News

- [[ithaca/news/day-3400-the-hall]] — Day 3,400: the hall

## Stores

- [[ithaca/stores/bow-of-eurytus]] — The bow of Eurytus
- [[ithaca/stores/goats]] — Goats
- [[ithaca/stores/swine]] — Swine

## Suitors

- [[ithaca/suitors/ithacans]] — From Ithaca: 12
- [[ithaca/suitors/same]] — From Same: 24

## Telemachus

- [[ithaca/telemachus/remembered]] — The boy, as I left him

## Other indexes

[[people/_index]] · [[decisions/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","ithaca/estate.md","ithaca/hall/daily-pattern.md","ithaca/homecoming-checklist.md","ithaca/household/eurycleia.md","ithaca/household/phemius.md","ithaca/island/arethusa.md","ithaca/island/laertes-farm.md","ithaca/island/neriton.md","ithaca/island/philoetius-cattle.md","ithaca/island/ravens-rock.md","ithaca/news/day-3400-the-hall.md","ithaca/reported-and-remembered.md","ithaca/stores/bow-of-eurytus.md","ithaca/stores/goats.md","ithaca/stores/swine.md","ithaca/suitors/ithacans.md","ithaca/suitors/same.md","ithaca/telemachus/remembered.md","people/_index.md","decisions/_index.md"],
  },
  {
    path: "voyage/log.md",
    title: "The voyage log",
    type: "index",
    created: "2016-08-01",
    updated: "2021-09-14",
    status: "active",
    tags: ["index"],
    summary: "Every leg from Troy to Ogygia, and the ship's log entries kept on the way.",
    body: `The voyage as it was sailed: one record per leg, then the log entries by day since Troy fell. The planned crossing is listed as planned.

38 records, as of the last revision.

## Log entries

- [[voyage/day-9-ismarus]] — Day 9 -- Ismarus
- [[voyage/day-25-driven-south]] — Day 25 -- driven south
- [[voyage/day-29-ninth-day]] — Day 29 -- the ninth day
- [[voyage/day-30-lotus-eaters]] — Day 30 -- the lotus coast
- [[voyage/day-31-leaving-the-lotus]] — Day 31 -- leaving the lotus coast
- [[voyage/day-96-goat-island]] — Day 96 -- the goat island
- [[voyage/day-132-aeolia-arrival]] — Day 132 -- Aeolia
- [[voyage/day-171-ithaca-in-sight]] — Day 171 -- Ithaca in sight
- [[voyage/day-172-aeolus-refuses]] — Day 172 -- Aeolus refuses
- [[voyage/day-205-laestrygonian-harbour]] — Day 205 -- the Laestrygonian harbour
- [[voyage/day-246-aeaea-arrival]] — Day 246 -- Aeaea
- [[voyage/day-248-moly]] — Day 248 -- moly
- [[voyage/day-437-equinox]] — Day 437 -- the autumn equinox
- [[voyage/day-611-elpenor]] — Day 611 -- leaving Aeaea; Elpenor
- [[voyage/day-620-acheron]] — Day 620 -- the house of the dead
- [[voyage/day-622-leaving-the-dead]] — Day 622 -- leaving the dead
- [[voyage/day-623-aeaea-return]] — Day 623 -- back on Aeaea
- [[voyage/day-800-season-closing]] — Day 800 -- the season closing again
- [[voyage/day-892-midwinter]] — Day 892 -- second midwinter on Aeaea
- [[voyage/day-1038-circes-route]] — Day 1,038 -- Circe gives the route
- [[voyage/day-1039-leaving-aeaea]] — Day 1,039 -- leaving Aeaea
- [[voyage/day-1043-strait]] — Day 1,043 -- the strait
- [[voyage/day-1050-wind-still-south]] — Day 1,050 -- wind still south
- [[voyage/day-1062-stores-out]] — Day 1,062 -- stores out
- [[voyage/day-1077-the-cattle]] — Day 1,077 -- the cattle
- [[voyage/day-1083-sixth-day]] — Day 1,083 -- the sixth day of feasting
- [[voyage/day-1084-the-storm]] — Day 1,084 -- the storm
- [[voyage/day-1085-the-fig-tree]] — Day 1,085 -- the fig tree
- [[voyage/day-1088-adrift]] — Day 1,088 -- adrift
- [[voyage/day-1095-ogygia]] — Day 1,095 -- Ogygia

## Legs

- [[voyage/legs/aeaea-first-stay]] — Leg 9 -- Aeaea, the first stay
- [[voyage/legs/aeaea-return]] — Leg 11 -- Aeaea, the second stay
- [[voyage/legs/aeolia]] — Leg 6 -- Aeolia, and the bag
- [[voyage/legs/cyclopes]] — Leg 5 -- The land of the Cyclopes
- [[voyage/legs/house-of-the-dead]] — Leg 10 -- To the house of the dead
- [[voyage/legs/laestrygonians]] — Leg 8 -- The Laestrygonian harbour
- [[voyage/legs/the-strait]] — Leg 13 -- The strait
- [[voyage/legs/troy-departure]] — Leg 1 -- Troy to the Thracian coast

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","voyage/_index.md","voyage/day-9-ismarus.md","voyage/day-25-driven-south.md","voyage/day-29-ninth-day.md","voyage/day-30-lotus-eaters.md","voyage/day-31-leaving-the-lotus.md","voyage/day-96-goat-island.md","voyage/day-132-aeolia-arrival.md","voyage/day-171-ithaca-in-sight.md","voyage/day-172-aeolus-refuses.md","voyage/day-205-laestrygonian-harbour.md","voyage/day-246-aeaea-arrival.md","voyage/day-248-moly.md","voyage/day-437-equinox.md","voyage/day-611-elpenor.md","voyage/day-620-acheron.md","voyage/day-622-leaving-the-dead.md","voyage/day-623-aeaea-return.md","voyage/day-800-season-closing.md","voyage/day-892-midwinter.md","voyage/day-1038-circes-route.md","voyage/day-1039-leaving-aeaea.md","voyage/day-1043-strait.md","voyage/day-1050-wind-still-south.md","voyage/day-1062-stores-out.md","voyage/day-1077-the-cattle.md","voyage/day-1083-sixth-day.md","voyage/day-1084-the-storm.md","voyage/day-1085-the-fig-tree.md","voyage/day-1088-adrift.md","voyage/day-1095-ogygia.md","voyage/legs/aeaea-first-stay.md","voyage/legs/aeaea-return.md","voyage/legs/aeolia.md","voyage/legs/cyclopes.md","voyage/legs/house-of-the-dead.md","voyage/legs/laestrygonians.md","voyage/legs/the-strait.md","voyage/legs/troy-departure.md"],
  },
  {
    path: "crew/register.md",
    title: "The crew register",
    type: "index",
    created: "2016-09-30",
    updated: "2020-01-30",
    status: "active",
    tags: ["index"],
    summary: "The twelve ships, the six losses, the named men and the records kept for the dead.",
    body: `Everything kept about the six hundred: rosters by ship, losses by place, roll calls, rotas and what is owed to their families.

39 records, as of the last revision.

## Records

- [[crew/aeaea-scouting-party]] — The scouting party on Aeaea
- [[crew/antiphus]] — Antiphus
- [[crew/barrow-on-aeaea]] — Elpenor's barrow
- [[crew/burials-and-cenotaphs]] — Burials and cenotaphs
- [[crew/cenotaph-plan]] — Cenotaph plan
- [[crew/elpenor]] — Elpenor
- [[crew/eurylochus]] — Eurylochus
- [[crew/families-owed-news]] — Families owed news
- [[crew/fleet-strength]] — Fleet strength over time
- [[crew/how-to-tell-a-family]] — How to tell a family
- [[crew/lotus-eaters]] — The three who ate the lotus
- [[crew/oar-bench-rota]] — Oar-bench rota, ship 1
- [[crew/open-questions]] — What the crew records still ask
- [[crew/polites]] — Polites
- [[crew/promises-to-the-dead]] — Promises to the dead
- [[crew/scylla-six]] — The six for Scylla
- [[crew/shares-owed]] — Shares owed
- [[crew/standing-orders]] — Standing orders

## Losses

- [[crew/losses/aeaea]] — Loss: Aeaea
- [[crew/losses/ismarus]] — Loss: Ismarus
- [[crew/losses/laestrygonians]] — Loss: the Laestrygonian harbour
- [[crew/losses/scylla]] — Loss: Scylla
- [[crew/losses/thrinacia]] — Loss: Thrinacia

## Roll calls

- [[crew/roll-calls/day-10]] — Roll call, day 10: after Ismarus
- [[crew/roll-calls/day-31]] — Roll call, day 31: leaving the Lotus-eaters
- [[crew/roll-calls/day-99]] — Roll call, day 99: back from the cave
- [[crew/roll-calls/day-172]] — Roll call, day 172: blown back to Aeolia
- [[crew/roll-calls/day-206]] — Roll call, day 206: one ship
- [[crew/roll-calls/day-620]] — Roll call, day 620: corrected at the pit
- [[crew/roll-calls/day-1043]] — Roll call, day 1,043: through the strait
- [[crew/roll-calls/day-1084]] — Roll call, day 1,084: the last one
- [[crew/roll-calls/day-1095]] — Roll call, day 1,095: Ogygia

## Ships

- [[crew/ships/ship-02]] — Ship 2
- [[crew/ships/ship-03]] — Ship 3
- [[crew/ships/ship-06]] — Ship 6
- [[crew/ships/ship-07]] — Ship 7
- [[crew/ships/ship-09]] — Ship 9
- [[crew/ships/ship-10]] — Ship 10
- [[crew/ships/ship-11]] — Ship 11

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","crew/_index.md","crew/aeaea-scouting-party.md","crew/antiphus.md","crew/barrow-on-aeaea.md","crew/burials-and-cenotaphs.md","crew/cenotaph-plan.md","crew/elpenor.md","crew/eurylochus.md","crew/families-owed-news.md","crew/fleet-strength.md","crew/how-to-tell-a-family.md","crew/losses/aeaea.md","crew/losses/ismarus.md","crew/losses/laestrygonians.md","crew/losses/scylla.md","crew/losses/thrinacia.md","crew/lotus-eaters.md","crew/oar-bench-rota.md","crew/open-questions.md","crew/polites.md","crew/promises-to-the-dead.md","crew/roll-calls/day-10.md","crew/roll-calls/day-31.md","crew/roll-calls/day-99.md","crew/roll-calls/day-172.md","crew/roll-calls/day-206.md","crew/roll-calls/day-620.md","crew/roll-calls/day-1043.md","crew/roll-calls/day-1084.md","crew/roll-calls/day-1095.md","crew/scylla-six.md","crew/shares-owed.md","crew/ships/ship-02.md","crew/ships/ship-03.md","crew/ships/ship-06.md","crew/ships/ship-07.md","crew/ships/ship-09.md","crew/ships/ship-10.md","crew/ships/ship-11.md","crew/standing-orders.md"],
  },
  {
    path: "ogygia/_index.md",
    title: "Ogygia",
    type: "index",
    created: "2019-07-30",
    updated: "2025-06-30",
    status: "active",
    tags: ["index"],
    summary: "The island, the cave and the workshop, after seven years.",
    body: `Seven years of records from Calypso's island: the cave, the garden, the shore, and the build that ends the stay.

12 records, as of the last revision.

## Island

- [[ogygia/island/cave]] — The cave
- [[ogygia/island/day-1095-landfall]] — Day 1,095 -- landfall
- [[ogygia/island/hearth]] — The hearth
- [[ogygia/island/meadows]] — The meadows
- [[ogygia/island/shore]] — The shore below the cave
- [[ogygia/island/survey]] — Walk-around survey
- [[ogygia/island/vine]] — The vine over the cave mouth

## Routine

- [[ogygia/routine/day-count]] — Keeping the count
- [[ogygia/routine/evenings]] — Evenings at the hearth
- [[ogygia/routine/meals]] — What I eat

## Records

- [[ogygia/the-offer]] — The offer

## Years

- [[ogygia/years/year-1]] — Year one on Ogygia

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","voyage/ogygia/_index.md","ogygia/island/cave.md","ogygia/island/day-1095-landfall.md","ogygia/island/hearth.md","ogygia/island/meadows.md","ogygia/island/shore.md","ogygia/island/survey.md","ogygia/island/vine.md","ogygia/routine/day-count.md","ogygia/routine/evenings.md","ogygia/routine/meals.md","ogygia/the-offer.md","ogygia/years/year-1.md"],
  },
];
