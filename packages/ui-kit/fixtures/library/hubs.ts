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
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "Everyone the voyage has met, owes or lost, by standing.",
    body: `The people Odysseus has dealt with since Troy, and the household he left. A record notes what is known and when it was last true; it is not a channel to anyone.

67 records.

## Records

- [[people/achilles]] — Achilles
- [[people/aegisthus]] — Aegisthus
- [[people/aegyptius]] — Aegyptius
- [[people/aeolus]] — Aeolus
- [[people/agamemnon]] — Agamemnon
- [[people/ajax-son-of-oileus]] — Ajax, son of Oileus
- [[people/ajax-son-of-telamon]] — Ajax, son of Telamon
- [[people/amphinomus]] — Amphinomus
- [[people/anticleia]] — Anticleia
- [[people/antilochus]] — Antilochus
- [[people/antinous]] — Antinous
- [[people/antiphates]] — Antiphates
- [[people/argos]] — Argos
- [[people/athena]] — Athena
- [[people/autolycus]] — Autolycus
- [[people/calchas]] — Calchas
- [[people/calypso]] — Calypso
- [[people/circe]] — Circe
- [[people/clytemnestra]] — Clytemnestra
- [[people/ctesippus]] — Ctesippus
- [[people/ctimene]] — Ctimene
- [[people/diomedes]] — Diomedes
- [[people/dolius]] — Dolius
- [[people/eumaeus]] — Eumaeus
- [[people/eupeithes]] — Eupeithes
- [[people/eurycleia]] — Eurycleia
- [[people/eurymachus]] — Eurymachus
- [[people/halitherses]] — Halitherses
- [[people/helen]] — Helen
- [[people/helios]] — Helios
- [[people/heracles]] — Heracles
- [[people/hermes]] — Hermes
- [[people/icarius]] — Icarius
- [[people/idomeneus]] — Idomeneus
- [[people/irus]] — Irus
- [[people/laertes]] — Laertes
- [[people/lampetie]] — Lampetie
- [[people/leiocritus]] — Leiocritus
- [[people/leodes]] — Leodes
- [[people/maron]] — Maron
- [[people/medon]] — Medon
- [[people/melanthius]] — Melanthius
- [[people/melantho]] — Melantho
- [[people/menelaus]] — Menelaus
- [[people/mentor]] — Mentor
- [[people/minos]] — Minos
- [[people/neoptolemus]] — Neoptolemus
- [[people/nestor]] — Nestor
- [[people/noemon]] — Noemon
- [[people/orestes]] — Orestes
- [[people/palamedes]] — Palamedes
- [[people/patroclus]] — Patroclus
- [[people/peisistratus]] — Peisistratus
- [[people/peleus]] — Peleus
- [[people/penelope]] — Penelope
- [[people/phemius]] — Phemius
- [[people/philoctetes]] — Philoctetes
- [[people/philoetius]] — Philoetius
- [[people/polyphemus]] — Polyphemus
- [[people/poseidon]] — Poseidon
- [[people/proteus]] — Proteus
- [[people/sisyphus]] — Sisyphus
- [[people/tantalus]] — Tantalus
- [[people/teiresias]] — Teiresias
- [[people/telemachus]] — Telemachus
- [[people/thoosa]] — Thoosa
- [[people/zeus]] — Zeus

## Other indexes

[[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","people/achilles.md","people/aegisthus.md","people/aegyptius.md","people/aeolus.md","people/agamemnon.md","people/ajax-son-of-oileus.md","people/ajax-son-of-telamon.md","people/amphinomus.md","people/anticleia.md","people/antilochus.md","people/antinous.md","people/antiphates.md","people/argos.md","people/athena.md","people/autolycus.md","people/calchas.md","people/calypso.md","people/circe.md","people/clytemnestra.md","people/ctesippus.md","people/ctimene.md","people/diomedes.md","people/dolius.md","people/eumaeus.md","people/eupeithes.md","people/eurycleia.md","people/eurymachus.md","people/halitherses.md","people/helen.md","people/helios.md","people/heracles.md","people/hermes.md","people/icarius.md","people/idomeneus.md","people/irus.md","people/laertes.md","people/lampetie.md","people/leiocritus.md","people/leodes.md","people/maron.md","people/medon.md","people/melanthius.md","people/melantho.md","people/menelaus.md","people/mentor.md","people/minos.md","people/neoptolemus.md","people/nestor.md","people/noemon.md","people/orestes.md","people/palamedes.md","people/patroclus.md","people/peisistratus.md","people/peleus.md","people/penelope.md","people/phemius.md","people/philoctetes.md","people/philoetius.md","people/polyphemus.md","people/poseidon.md","people/proteus.md","people/sisyphus.md","people/tantalus.md","people/teiresias.md","people/telemachus.md","people/thoosa.md","people/zeus.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "knowledge/_index.md",
    title: "Knowledge",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "What the voyage has learned about the sea, the gods and the hazards between.",
    body: `Hazards, gods, winds, stars and the practical knowledge of keeping a ship alive. Entries record what was told, by whom, and whether it proved true.

44 records.

## Records

- [[knowledge/aeolus]] — Aeolus, keeper of the winds
- [[knowledge/athena-favour]] — Athena's favour
- [[knowledge/bailing]] — Bailing
- [[knowledge/beaching]] — Beaching a ship
- [[knowledge/bootes]] — Boötes
- [[knowledge/boreas]] — Boreas, the north wind
- [[knowledge/charybdis]] — Charybdis
- [[knowledge/circe-drugs]] — Circe's drugs
- [[knowledge/cyclopes-customs]] — The Cyclopes' customs
- [[knowledge/cyclops-door-stone]] — The stone across the cave
- [[knowledge/eurus]] — Eurus, the east wind
- [[knowledge/fevers]] — Fevers and thirst
- [[knowledge/great-bear]] — The Great Bear
- [[knowledge/guest-friendship]] — Guest-friendship
- [[knowledge/guest-gifts]] — Guest-gifts
- [[knowledge/helios]] — Helios, as he bears on a sailor
- [[knowledge/hermes]] — Hermes
- [[knowledge/laestrygonians]] — The Laestrygonians
- [[knowledge/lotus]] — The lotus
- [[knowledge/mast-stepping]] — Stepping and lowering the mast
- [[knowledge/moly]] — Moly
- [[knowledge/mooring]] — Mooring stones and stern cables
- [[knowledge/notus]] — Notus, the south wind
- [[knowledge/oar-counts]] — Oars and men
- [[knowledge/order-of-the-shades]] — The order of the shades
- [[knowledge/orion]] — Orion
- [[knowledge/pleiades]] — The Pleiades
- [[knowledge/poseidon-at-sea]] — Poseidon, as he bears on a sailor
- [[knowledge/raft-construction]] — How a raft is built
- [[knowledge/reading-a-coast]] — Reading a coast
- [[knowledge/rites-for-the-dead]] — The rites for the dead
- [[knowledge/sacrifice-procedure]] — Sacrifice procedure
- [[knowledge/scylla]] — Scylla
- [[knowledge/sea-provisions]] — Provisions that keep at sea
- [[knowledge/sirens]] — Sirens
- [[knowledge/steering-oar]] — The steering oar
- [[knowledge/suppliants]] — Supplication
- [[knowledge/teiresias-forecast]] — The forecast
- [[knowledge/thrinacia-cattle]] — The cattle of Helios
- [[knowledge/wandering-rocks]] — The Wandering Rocks
- [[knowledge/watering-parties]] — Watering parties
- [[knowledge/wounds]] — Wounds
- [[knowledge/zephyrus]] — Zephyrus, the west wind
- [[knowledge/zeus]] — Zeus, as he bears on a sailor

## Other indexes

[[people/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","knowledge/aeolus.md","knowledge/athena-favour.md","knowledge/bailing.md","knowledge/beaching.md","knowledge/bootes.md","knowledge/boreas.md","knowledge/charybdis.md","knowledge/circe-drugs.md","knowledge/cyclopes-customs.md","knowledge/cyclops-door-stone.md","knowledge/eurus.md","knowledge/fevers.md","knowledge/great-bear.md","knowledge/guest-friendship.md","knowledge/guest-gifts.md","knowledge/helios.md","knowledge/hermes.md","knowledge/laestrygonians.md","knowledge/lotus.md","knowledge/mast-stepping.md","knowledge/moly.md","knowledge/mooring.md","knowledge/notus.md","knowledge/oar-counts.md","knowledge/order-of-the-shades.md","knowledge/orion.md","knowledge/pleiades.md","knowledge/poseidon-at-sea.md","knowledge/raft-construction.md","knowledge/reading-a-coast.md","knowledge/rites-for-the-dead.md","knowledge/sacrifice-procedure.md","knowledge/scylla.md","knowledge/sea-provisions.md","knowledge/sirens.md","knowledge/steering-oar.md","knowledge/suppliants.md","knowledge/teiresias-forecast.md","knowledge/thrinacia-cattle.md","knowledge/wandering-rocks.md","knowledge/watering-parties.md","knowledge/wounds.md","knowledge/zephyrus.md","knowledge/zeus.md","people/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "studies/_index.md",
    title: "Studies",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "Longer pieces of reading and reasoning, kept for the crossing.",
    body: `Navigation, weather and seamanship, worked through at length. Shorter facts live in knowledge.

14 records.

## Records

- [[studies/crossing-distance-and-margin]] — 632 km in 17 days, and the margin
- [[studies/forecast-after-the-crossing]] — What the forecast still predicts
- [[studies/july-weather]] — July weather on this sea
- [[studies/losses-by-hazard]] — Six hundred, by cause
- [[studies/poseidon-risk]] — Poseidon, as a risk to the crossing
- [[studies/provisions-for-seventeen-days]] — Bread and wine for seventeen days
- [[studies/raft-versus-ship]] — A raft's handling against a ship's
- [[studies/sail-handling-alone]] — Handling the sail alone
- [[studies/signs-of-land]] — Signs of land from the open sea
- [[studies/sleep-on-a-single-hand-crossing]] — Sleep on a single-handed crossing
- [[studies/steering-by-the-bear]] — Steering by the Bear, east of north
- [[studies/strait-passages-compared]] — The strait passages compared
- [[studies/water-ration]] — Water: one skin, seventeen days
- [[studies/wind-for-the-heading]] — Which winds serve a north-east heading

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","studies/crossing-distance-and-margin.md","studies/forecast-after-the-crossing.md","studies/july-weather.md","studies/losses-by-hazard.md","studies/poseidon-risk.md","studies/provisions-for-seventeen-days.md","studies/raft-versus-ship.md","studies/sail-handling-alone.md","studies/signs-of-land.md","studies/sleep-on-a-single-hand-crossing.md","studies/steering-by-the-bear.md","studies/strait-passages-compared.md","studies/water-ration.md","studies/wind-for-the-heading.md","people/_index.md","knowledge/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "journal/_index.md",
    title: "Journal",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "One entry per day since Troy fell, numbered from that day.",
    body: `Entries are named by the day count since Troy fell: day 1 is the morning after. Day 3652 is today.

60 records.

## Records

- [[journal/day-10]] — Day 10
- [[journal/day-97]] — Day 97
- [[journal/day-100]] — Day 100
- [[journal/day-172]] — Day 172
- [[journal/day-206]] — Day 206
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
- [[journal/day-1825]] — Day 1,825
- [[journal/day-2000]] — Day 2,000
- [[journal/day-2190]] — Day 2,190
- [[journal/day-2400]] — Day 2,400
- [[journal/day-2555]] — Day 2,555
- [[journal/day-2557]] — Day 2,557
- [[journal/day-2914]] — Day 2,914
- [[journal/day-2920]] — Day 2,920
- [[journal/day-3100]] — Day 3,100
- [[journal/day-3285]] — Day 3,285
- [[journal/day-3400]] — Day 3,400
- [[journal/day-3610]] — Day 3,610
- [[journal/day-3612]] — Day 3,612
- [[journal/day-3614]] — Day 3,614
- [[journal/day-3616]] — Day 3,616
- [[journal/day-3618]] — Day 3,618
- [[journal/day-3620]] — Day 3,620
- [[journal/day-3622]] — Day 3,622
- [[journal/day-3624]] — Day 3,624
- [[journal/day-3626]] — Day 3,626
- [[journal/day-3628]] — Day 3,628
- [[journal/day-3630]] — Day 3,630
- [[journal/day-3632]] — Day 3,632
- [[journal/day-3634]] — Day 3,634
- [[journal/day-3636]] — Day 3,636
- [[journal/day-3638]] — Day 3,638
- [[journal/day-3640]] — Day 3,640
- [[journal/day-3641]] — Day 3,641
- [[journal/day-3642]] — Day 3,642
- [[journal/day-3643]] — Day 3,643
- [[journal/day-3644]] — Day 3,644
- [[journal/day-3645]] — Day 3,645
- [[journal/day-3646]] — Day 3,646
- [[journal/day-3647]] — Day 3,647
- [[journal/day-3648]] — Day 3,648
- [[journal/day-3649]] — Day 3,649
- [[journal/day-3650]] — Day 3,650
- [[journal/day-3651]] — Day 3,651
- [[journal/day-3652]] — Day 3,652

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","journal/day-10.md","journal/day-97.md","journal/day-100.md","journal/day-172.md","journal/day-206.md","journal/day-430.md","journal/day-621.md","journal/day-1044.md","journal/day-1090.md","journal/day-1095.md","journal/day-1096.md","journal/day-1098.md","journal/day-1102.md","journal/day-1110.md","journal/day-1130.md","journal/day-1180.md","journal/day-1300.md","journal/day-1460.md","journal/day-1575.md","journal/day-1576.md","journal/day-1600.md","journal/day-1825.md","journal/day-2000.md","journal/day-2190.md","journal/day-2400.md","journal/day-2555.md","journal/day-2557.md","journal/day-2914.md","journal/day-2920.md","journal/day-3100.md","journal/day-3285.md","journal/day-3400.md","journal/day-3610.md","journal/day-3612.md","journal/day-3614.md","journal/day-3616.md","journal/day-3618.md","journal/day-3620.md","journal/day-3622.md","journal/day-3624.md","journal/day-3626.md","journal/day-3628.md","journal/day-3630.md","journal/day-3632.md","journal/day-3634.md","journal/day-3636.md","journal/day-3638.md","journal/day-3640.md","journal/day-3641.md","journal/day-3642.md","journal/day-3643.md","journal/day-3644.md","journal/day-3645.md","journal/day-3646.md","journal/day-3647.md","journal/day-3648.md","journal/day-3649.md","journal/day-3650.md","journal/day-3651.md","journal/day-3652.md","people/_index.md","knowledge/_index.md","studies/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "decisions/_index.md",
    title: "Decisions",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "Every choice that cost something, with what it cost.",
    body: `A decision record states the options, the choice, the cost and what is still worth reviewing. Closed decisions stay closed; the questions they leave stay open.

32 records.

## Records

- [[decisions/accept-calypso-release]] — Accept Calypso's release, on oath
- [[decisions/accept-the-bag-of-winds]] — Accept the bag of winds
- [[decisions/arm-against-scylla]] — Arm against Scylla
- [[decisions/blind-rather-than-kill]] — Blind him rather than kill him
- [[decisions/build-rather-than-wait]] — Build a raft rather than wait for a ship
- [[decisions/bury-elpenor-first]] — Bury Elpenor before anything else
- [[decisions/cattle-of-helios]] — The cattle on Thrinacia
- [[decisions/cut-the-cable]] — Cut the cable and row
- [[decisions/drag-back-the-lotus-eaters]] — Drag the lotus-eaters back to the ships
- [[decisions/enter-the-cave]] — Enter the cave
- [[decisions/go-to-circe-alone]] — Go to Circe alone, with moly
- [[decisions/go-to-the-dead]] — Go to the house of the dead
- [[decisions/hear-the-sirens]] — Hear the Sirens, bound
- [[decisions/hold-the-fig-tree]] — Hold the fig tree
- [[decisions/keep-the-helm-nine-days]] — Keep the helm nine days and sleep on the tenth
- [[decisions/land-on-thrinacia]] — Land on Thrinacia
- [[decisions/leave-today]] — Leave today rather than after the season
- [[decisions/moor-outside-the-harbour]] — Moor ship 1 outside the harbour
- [[decisions/name-at-the-stern]] — Giving the name at the stern
- [[decisions/nobody-as-the-name]] — Give the name as Nobody
- [[decisions/raid-ismarus]] — Raid Ismarus
- [[decisions/refuse-immortality]] — Refuse immortality
- [[decisions/return-to-aeolus]] — Go back and ask Aeolus again
- [[decisions/sail-by-the-bear]] — Steer by the Bear, east of north
- [[decisions/scylla-or-charybdis]] — Scylla or Charybdis
- [[decisions/spare-maron]] — Spare Maron, priest of Apollo
- [[decisions/split-the-crew-on-aeaea]] — Split the crew on Aeaea
- [[decisions/stay-the-night-at-ismarus]] — Stay the night at Ismarus
- [[decisions/stay-the-year]] — Stay the year on Aeaea
- [[decisions/wait-for-polyphemus]] — Wait for the owner of the cave
- [[decisions/wait-out-the-seasons]] — Wait out the seasons on Aeaea
- [[decisions/what-to-tell-the-crew]] — Tell the crew about the Sirens, not about Scylla

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","decisions/accept-calypso-release.md","decisions/accept-the-bag-of-winds.md","decisions/arm-against-scylla.md","decisions/blind-rather-than-kill.md","decisions/build-rather-than-wait.md","decisions/bury-elpenor-first.md","decisions/cattle-of-helios.md","decisions/cut-the-cable.md","decisions/drag-back-the-lotus-eaters.md","decisions/enter-the-cave.md","decisions/go-to-circe-alone.md","decisions/go-to-the-dead.md","decisions/hear-the-sirens.md","decisions/hold-the-fig-tree.md","decisions/keep-the-helm-nine-days.md","decisions/land-on-thrinacia.md","decisions/leave-today.md","decisions/moor-outside-the-harbour.md","decisions/name-at-the-stern.md","decisions/nobody-as-the-name.md","decisions/raid-ismarus.md","decisions/refuse-immortality.md","decisions/return-to-aeolus.md","decisions/sail-by-the-bear.md","decisions/scylla-or-charybdis.md","decisions/spare-maron.md","decisions/split-the-crew-on-aeaea.md","decisions/stay-the-night-at-ismarus.md","decisions/stay-the-year.md","decisions/wait-for-polyphemus.md","decisions/wait-out-the-seasons.md","decisions/what-to-tell-the-crew.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "oaths/_index.md",
    title: "Oaths",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "Oaths sworn, received and broken, and who holds each one.",
    body: `An oath is recorded with who swore it, by what, and its standing today.

13 records.

## Records

- [[oaths/calypso-no-harm]] — Calypso's oath not to plot harm
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

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","oaths/calypso-no-harm.md","oaths/circe-no-harm.md","oaths/helios.md","oaths/maron-guest-gift.md","oaths/polyphemus-curse.md","oaths/promise-to-elpenor.md","oaths/promise-to-penelope.md","oaths/sirens-binding-order.md","oaths/teiresias-inland-journey.md","oaths/tyndareus-oath.md","oaths/vow-to-the-dead.md","oaths/xenia-aeolus.md","oaths/xenia-polyphemus.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "omens/_index.md",
    title: "Omens",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "Signs observed, with what each was taken to mean and whether it held.",
    body: `An omen is logged as an observation first and an interpretation second. Birds are described by what they were doing.

16 records.

## Records

- [[omens/aulis-serpent]] — The serpent at Aulis
- [[omens/day-21-malea-wind]] — North wind and current at Malea
- [[omens/day-99-ram-refused]] — The ram on the beach, not accepted
- [[omens/day-172-aeolus-reading]] — Aeolus reads the return
- [[omens/day-246-the-stag]] — The stag on the path
- [[omens/day-1041-calm]] — A calm before the Sirens
- [[omens/day-1078-hides-crawled]] — The hides crawled
- [[omens/day-1084-thunder]] — Thunder, and the ship struck
- [[omens/day-3644-two-eagles]] — Two eagles over the assembly
- [[omens/day-3646-hawk]] — Hawk on the right hand
- [[omens/day-3648-sneeze]] — A sneeze at the first tree
- [[omens/day-3649-sister-dream]] — Penelope's dream of her sister
- [[omens/day-3650-the-bear]] — The Bear does not set
- [[omens/day-3651-eagle]] — Eagle over the courtyard
- [[omens/day-3652-dawn-wind]] — Wind at first light, offshore
- [[omens/heron-in-the-dark]] — Heron on the right, at night

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","omens/aulis-serpent.md","omens/day-21-malea-wind.md","omens/day-99-ram-refused.md","omens/day-172-aeolus-reading.md","omens/day-246-the-stag.md","omens/day-1041-calm.md","omens/day-1078-hides-crawled.md","omens/day-1084-thunder.md","omens/day-3644-two-eagles.md","omens/day-3646-hawk.md","omens/day-3648-sneeze.md","omens/day-3649-sister-dream.md","omens/day-3650-the-bear.md","omens/day-3651-eagle.md","omens/day-3652-dawn-wind.md","omens/heron-in-the-dark.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "ithaca/_index.md",
    title: "Ithaca",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "The household, the estate and the island, as far as news reaches.",
    body: `What is known of home: the household, the herds, the hall and the island. News is dated by when it arrived, not when it happened.

66 records.

## Records

- [[ithaca/departure-instructions]] — What I told her when I left
- [[ithaca/homecoming-checklist]] — Homecoming checklist
- [[ithaca/questions-on-landing]] — Questions to ask on landing
- [[ithaca/reported-and-remembered]] — Reported and remembered
- [[ithaca/timeline]] — Ithaca, four years in order

## Hall

- [[ithaca/hall/daily-pattern]] — A day in the hall, as reported
- [[ithaca/hall/plan]] — The hall, as built
- [[ithaca/hall/weapons]] — Arms on the hall walls

## Household

- [[ithaca/household/anticleia]] — My mother
- [[ithaca/household/argos]] — Argos, no report
- [[ithaca/household/eurycleia]] — Eurycleia
- [[ithaca/household/medon]] — Medon, the herald
- [[ithaca/household/mentor]] — Mentor
- [[ithaca/household/penelope-standing]] — Penelope's position
- [[ithaca/household/phemius]] — Phemius, the singer
- [[ithaca/household/roster]] — The household, by count
- [[ithaca/household/the-twelve]] — The twelve
- [[ithaca/household/women-servants]] — The fifty women

## Island

- [[ithaca/island/arethusa]] — The spring Arethusa
- [[ithaca/island/eumaeus-yard]] — The swine yard
- [[ithaca/island/geography]] — The island, from memory
- [[ithaca/island/harbour-of-phorcys]] — The harbour of Phorcys
- [[ithaca/island/laertes-farm]] — My father's farm
- [[ithaca/island/neriton]] — Mount Neriton
- [[ithaca/island/orchard]] — The trees he gave me
- [[ithaca/island/philoetius-cattle]] — Philoetius and the cattle
- [[ithaca/island/ravens-rock]] — Raven's Rock
- [[ithaca/island/the-bed]] — The bed

## Loom

- [[ithaca/loom/discovery]] — Who told about the loom
- [[ithaca/loom/shroud]] — The shroud for Laertes

## News

- [[ithaca/news/day-3221-laertes]] — Day 3,221: my father, on the farm
- [[ithaca/news/day-3400-the-hall]] — Day 3,400: the hall
- [[ithaca/news/day-3614-eumaeus]] — Day 3,614: from the swine yard
- [[ithaca/news/day-3640-shroud-finished]] — Day 3,640: the shroud finished, the pressure on
- [[ithaca/news/day-3644-assembly]] — Day 3,644: the assembly, and the boy has sailed
- [[ithaca/news/day-3646-ambush]] — Day 3,646: a ship sent to Asteris
- [[ithaca/news/day-3646-pylos]] — Day 3,646: at Pylos
- [[ithaca/news/day-3647-hermes]] — Day 3,647: what Hermes did not say
- [[ithaca/news/day-3648-medon]] — Day 3,648: Penelope knows
- [[ithaca/news/day-3649-sparta]] — Day 3,649: at Sparta
- [[ithaca/news/log]] — News from Ithaca

## Stores

- [[ithaca/stores/bow-of-eurytus]] — The bow of Eurytus
- [[ithaca/stores/cattle]] — Cattle
- [[ithaca/stores/daily-rate]] — The rate, per day
- [[ithaca/stores/drawdown]] — Stores drawdown
- [[ithaca/stores/goats]] — Goats
- [[ithaca/stores/sheep]] — Sheep
- [[ithaca/stores/storeroom]] — The storeroom
- [[ithaca/stores/swine]] — Swine
- [[ithaca/stores/twelve-axes]] — The twelve axes
- [[ithaca/stores/wine]] — Wine

## Suitors

- [[ithaca/suitors/ambush-ship]] — The ship at Asteris
- [[ithaca/suitors/dulichium]] — From Dulichium: 52
- [[ithaca/suitors/families]] — The families behind the 108
- [[ithaca/suitors/ithacans]] — From Ithaca: 12
- [[ithaca/suitors/retinue]] — Who serves the suitors
- [[ithaca/suitors/roster]] — The suitors, by island
- [[ithaca/suitors/same]] — From Same: 24
- [[ithaca/suitors/their-case]] — The suitors' case, stated fairly
- [[ithaca/suitors/zacynthus]] — From Zacynthus: 20

## Telemachus

- [[ithaca/telemachus/assembly]] — The assembly Telemachus called
- [[ithaca/telemachus/remembered]] — The boy, as I left him
- [[ithaca/telemachus/return-risk]] — His way home
- [[ithaca/telemachus/route]] — His route: Pylos, then Sparta
- [[ithaca/telemachus/ship-and-crew]] — His ship and crew
- [[ithaca/telemachus/what-he-heard]] — What he was told abroad

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[voyage/log]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","ithaca/estate.md","ithaca/departure-instructions.md","ithaca/hall/daily-pattern.md","ithaca/hall/plan.md","ithaca/hall/weapons.md","ithaca/homecoming-checklist.md","ithaca/household/anticleia.md","ithaca/household/argos.md","ithaca/household/eurycleia.md","ithaca/household/medon.md","ithaca/household/mentor.md","ithaca/household/penelope-standing.md","ithaca/household/phemius.md","ithaca/household/roster.md","ithaca/household/the-twelve.md","ithaca/household/women-servants.md","ithaca/island/arethusa.md","ithaca/island/eumaeus-yard.md","ithaca/island/geography.md","ithaca/island/harbour-of-phorcys.md","ithaca/island/laertes-farm.md","ithaca/island/neriton.md","ithaca/island/orchard.md","ithaca/island/philoetius-cattle.md","ithaca/island/ravens-rock.md","ithaca/island/the-bed.md","ithaca/loom/discovery.md","ithaca/loom/shroud.md","ithaca/news/day-3221-laertes.md","ithaca/news/day-3400-the-hall.md","ithaca/news/day-3614-eumaeus.md","ithaca/news/day-3640-shroud-finished.md","ithaca/news/day-3644-assembly.md","ithaca/news/day-3646-ambush.md","ithaca/news/day-3646-pylos.md","ithaca/news/day-3647-hermes.md","ithaca/news/day-3648-medon.md","ithaca/news/day-3649-sparta.md","ithaca/news/log.md","ithaca/questions-on-landing.md","ithaca/reported-and-remembered.md","ithaca/stores/bow-of-eurytus.md","ithaca/stores/cattle.md","ithaca/stores/daily-rate.md","ithaca/stores/drawdown.md","ithaca/stores/goats.md","ithaca/stores/sheep.md","ithaca/stores/storeroom.md","ithaca/stores/swine.md","ithaca/stores/twelve-axes.md","ithaca/stores/wine.md","ithaca/suitors/ambush-ship.md","ithaca/suitors/dulichium.md","ithaca/suitors/families.md","ithaca/suitors/ithacans.md","ithaca/suitors/retinue.md","ithaca/suitors/roster.md","ithaca/suitors/same.md","ithaca/suitors/their-case.md","ithaca/suitors/zacynthus.md","ithaca/telemachus/assembly.md","ithaca/telemachus/remembered.md","ithaca/telemachus/return-risk.md","ithaca/telemachus/route.md","ithaca/telemachus/ship-and-crew.md","ithaca/telemachus/what-he-heard.md","ithaca/timeline.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","voyage/log.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "voyage/log.md",
    title: "The voyage log",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "Every leg from Troy to Ogygia, and the ship's log entries kept on the way.",
    body: `The voyage as it was sailed: one record per leg, then the log entries by day since Troy fell. The planned crossing is listed as planned.

65 records.

## Log entries

- [[voyage/day-3-departure]] — Day 3 -- away from Troy
- [[voyage/day-9-ismarus]] — Day 9 -- Ismarus
- [[voyage/day-10-ismarus-morning-after]] — Day 10 -- the morning after Ismarus
- [[voyage/day-21-cape-malea]] — Day 21 -- Cape Malea
- [[voyage/day-25-driven-south]] — Day 25 -- driven south
- [[voyage/day-29-ninth-day]] — Day 29 -- the ninth day
- [[voyage/day-30-lotus-eaters]] — Day 30 -- the lotus coast
- [[voyage/day-31-leaving-the-lotus]] — Day 31 -- leaving the lotus coast
- [[voyage/day-96-goat-island]] — Day 96 -- the goat island
- [[voyage/day-97-the-cave]] — Day 97 -- the cave
- [[voyage/day-98-the-stake]] — Day 98 -- the stake
- [[voyage/day-99-escape]] — Day 99 -- out of the cave
- [[voyage/day-132-aeolia-arrival]] — Day 132 -- Aeolia
- [[voyage/day-162-aeolia-departure]] — Day 162 -- the bag
- [[voyage/day-167-west-wind-holding]] — Day 167 -- the west wind holding
- [[voyage/day-171-ithaca-in-sight]] — Day 171 -- Ithaca in sight
- [[voyage/day-172-aeolus-refuses]] — Day 172 -- Aeolus refuses
- [[voyage/day-205-laestrygonian-harbour]] — Day 205 -- the Laestrygonian harbour
- [[voyage/day-206-one-ship]] — Day 206 -- one ship
- [[voyage/day-246-aeaea-arrival]] — Day 246 -- Aeaea
- [[voyage/day-247-the-swine]] — Day 247 -- the swine
- [[voyage/day-248-moly]] — Day 248 -- moly
- [[voyage/day-345-midsummer]] — Day 345 -- midsummer on Aeaea
- [[voyage/day-437-equinox]] — Day 437 -- the autumn equinox
- [[voyage/day-528-midwinter]] — Day 528 -- midwinter on Aeaea
- [[voyage/day-608-the-crew-ask]] — Day 608 -- the crew ask
- [[voyage/day-611-elpenor]] — Day 611 -- leaving Aeaea; Elpenor
- [[voyage/day-620-acheron]] — Day 620 -- the house of the dead
- [[voyage/day-622-leaving-the-dead]] — Day 622 -- leaving the dead
- [[voyage/day-623-aeaea-return]] — Day 623 -- back on Aeaea
- [[voyage/day-624-elpenor-buried]] — Day 624 -- Elpenor buried
- [[voyage/day-800-season-closing]] — Day 800 -- the season closing again
- [[voyage/day-892-midwinter]] — Day 892 -- second midwinter on Aeaea
- [[voyage/day-1038-circes-route]] — Day 1,038 -- Circe gives the route
- [[voyage/day-1039-leaving-aeaea]] — Day 1,039 -- leaving Aeaea
- [[voyage/day-1040-eve-of-the-sirens]] — Day 1,040 -- the eve of the Sirens
- [[voyage/day-1041-sirens]] — Day 1,041 -- the Sirens
- [[voyage/day-1043-strait]] — Day 1,043 -- the strait
- [[voyage/day-1044-thrinacia-landfall]] — Day 1,044 -- Thrinacia
- [[voyage/day-1050-wind-still-south]] — Day 1,050 -- wind still south
- [[voyage/day-1062-stores-out]] — Day 1,062 -- stores out
- [[voyage/day-1077-the-cattle]] — Day 1,077 -- the cattle
- [[voyage/day-1083-sixth-day]] — Day 1,083 -- the sixth day of feasting
- [[voyage/day-1084-the-storm]] — Day 1,084 -- the storm
- [[voyage/day-1085-the-fig-tree]] — Day 1,085 -- the fig tree
- [[voyage/day-1088-adrift]] — Day 1,088 -- adrift
- [[voyage/day-1092-adrift]] — Day 1,092 -- adrift, the seventh day
- [[voyage/day-1095-ogygia]] — Day 1,095 -- Ogygia

## Legs

- [[voyage/legs/aeaea-first-stay]] — Leg 9 -- Aeaea, the first stay
- [[voyage/legs/aeaea-return]] — Leg 11 -- Aeaea, the second stay
- [[voyage/legs/aeolia]] — Leg 6 -- Aeolia, and the bag
- [[voyage/legs/cape-malea]] — Leg 3 -- Round Malea, and off the chart
- [[voyage/legs/cyclopes]] — Leg 5 -- The land of the Cyclopes
- [[voyage/legs/drift-to-ogygia]] — Leg 16 -- Adrift to Ogygia
- [[voyage/legs/house-of-the-dead]] — Leg 10 -- To the house of the dead
- [[voyage/legs/ismarus]] — Leg 2 -- Ismarus and the Cicones
- [[voyage/legs/ithaca-in-sight]] — Leg 7 -- Ithaca in sight, and the bag opened
- [[voyage/legs/laestrygonians]] — Leg 8 -- The Laestrygonian harbour
- [[voyage/legs/lotus-eaters]] — Leg 4 -- The land of the Lotus-eaters
- [[voyage/legs/ogygia-to-scheria]] — Leg 17 -- Ogygia to Scheria (planned)
- [[voyage/legs/sirens]] — Leg 12 -- Past the Sirens
- [[voyage/legs/the-strait]] — Leg 13 -- The strait
- [[voyage/legs/the-wreck-and-charybdis]] — Leg 15 -- The wreck, and Charybdis again
- [[voyage/legs/thrinacia]] — Leg 14 -- Thrinacia
- [[voyage/legs/troy-departure]] — Leg 1 -- Troy to the Thracian coast

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[crew/register]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","voyage/_index.md","voyage/day-3-departure.md","voyage/day-9-ismarus.md","voyage/day-10-ismarus-morning-after.md","voyage/day-21-cape-malea.md","voyage/day-25-driven-south.md","voyage/day-29-ninth-day.md","voyage/day-30-lotus-eaters.md","voyage/day-31-leaving-the-lotus.md","voyage/day-96-goat-island.md","voyage/day-97-the-cave.md","voyage/day-98-the-stake.md","voyage/day-99-escape.md","voyage/day-132-aeolia-arrival.md","voyage/day-162-aeolia-departure.md","voyage/day-167-west-wind-holding.md","voyage/day-171-ithaca-in-sight.md","voyage/day-172-aeolus-refuses.md","voyage/day-205-laestrygonian-harbour.md","voyage/day-206-one-ship.md","voyage/day-246-aeaea-arrival.md","voyage/day-247-the-swine.md","voyage/day-248-moly.md","voyage/day-345-midsummer.md","voyage/day-437-equinox.md","voyage/day-528-midwinter.md","voyage/day-608-the-crew-ask.md","voyage/day-611-elpenor.md","voyage/day-620-acheron.md","voyage/day-622-leaving-the-dead.md","voyage/day-623-aeaea-return.md","voyage/day-624-elpenor-buried.md","voyage/day-800-season-closing.md","voyage/day-892-midwinter.md","voyage/day-1038-circes-route.md","voyage/day-1039-leaving-aeaea.md","voyage/day-1040-eve-of-the-sirens.md","voyage/day-1041-sirens.md","voyage/day-1043-strait.md","voyage/day-1044-thrinacia-landfall.md","voyage/day-1050-wind-still-south.md","voyage/day-1062-stores-out.md","voyage/day-1077-the-cattle.md","voyage/day-1083-sixth-day.md","voyage/day-1084-the-storm.md","voyage/day-1085-the-fig-tree.md","voyage/day-1088-adrift.md","voyage/day-1092-adrift.md","voyage/day-1095-ogygia.md","voyage/legs/aeaea-first-stay.md","voyage/legs/aeaea-return.md","voyage/legs/aeolia.md","voyage/legs/cape-malea.md","voyage/legs/cyclopes.md","voyage/legs/drift-to-ogygia.md","voyage/legs/house-of-the-dead.md","voyage/legs/ismarus.md","voyage/legs/ithaca-in-sight.md","voyage/legs/laestrygonians.md","voyage/legs/lotus-eaters.md","voyage/legs/ogygia-to-scheria.md","voyage/legs/sirens.md","voyage/legs/the-strait.md","voyage/legs/the-wreck-and-charybdis.md","voyage/legs/thrinacia.md","voyage/legs/troy-departure.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","crew/register.md","ogygia/_index.md"],
  },
  {
    path: "crew/register.md",
    title: "The crew register",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "The twelve ships, the six losses, the named men and the records kept for the dead.",
    body: `Everything kept about the six hundred: rosters by ship, losses by place, roll calls, rotas and what is owed to their families.

56 records.

## Records

- [[crew/aeaea-scouting-party]] — The scouting party on Aeaea
- [[crew/aeolia-bag]] — The bag of winds
- [[crew/antiphus]] — Antiphus
- [[crew/barrow-on-aeaea]] — Elpenor's barrow
- [[crew/burials-and-cenotaphs]] — Burials and cenotaphs
- [[crew/cave-party]] — The cave party
- [[crew/cenotaph-plan]] — Cenotaph plan
- [[crew/dissent-log]] — Dissent log
- [[crew/elpenor]] — Elpenor
- [[crew/eurylochus]] — Eurylochus
- [[crew/families-owed-news]] — Families owed news
- [[crew/fleet-strength]] — Fleet strength over time
- [[crew/helmsmen]] — The twelve helmsmen
- [[crew/how-to-tell-a-family]] — How to tell a family
- [[crew/ismarus-wine-ration]] — The Ismarus wine ration
- [[crew/lotus-eaters]] — The three who ate the lotus
- [[crew/oar-bench-rota]] — Oar-bench rota, ship 1
- [[crew/oath-signatories]] — Who swore the oath on Thrinacia
- [[crew/open-questions]] — What the crew records still ask
- [[crew/perimedes]] — Perimedes
- [[crew/polites]] — Polites
- [[crew/promises-to-the-dead]] — Promises to the dead
- [[crew/scylla-six]] — The six for Scylla
- [[crew/shares-owed]] — Shares owed
- [[crew/sirens-wax]] — Wax for the Sirens
- [[crew/standing-orders]] — Standing orders
- [[crew/thrinacia-provisions]] — Provisions on Thrinacia
- [[crew/watch-rota]] — Watch rota

## Losses

- [[crew/losses/aeaea]] — Loss: Aeaea
- [[crew/losses/cyclopes]] — Loss: the Cyclops's cave
- [[crew/losses/ismarus]] — Loss: Ismarus
- [[crew/losses/laestrygonians]] — Loss: the Laestrygonian harbour
- [[crew/losses/scylla]] — Loss: Scylla
- [[crew/losses/thrinacia]] — Loss: Thrinacia

## Roll calls

- [[crew/roll-calls/day-3]] — Roll call, day 3: sailing from Troy
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

- [[crew/ships/ship-01]] — Ship 1
- [[crew/ships/ship-02]] — Ship 2
- [[crew/ships/ship-03]] — Ship 3
- [[crew/ships/ship-04]] — Ship 4
- [[crew/ships/ship-05]] — Ship 5
- [[crew/ships/ship-06]] — Ship 6
- [[crew/ships/ship-07]] — Ship 7
- [[crew/ships/ship-08]] — Ship 8
- [[crew/ships/ship-09]] — Ship 9
- [[crew/ships/ship-10]] — Ship 10
- [[crew/ships/ship-11]] — Ship 11
- [[crew/ships/ship-12]] — Ship 12

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[ogygia/_index]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","crew/_index.md","crew/aeaea-scouting-party.md","crew/aeolia-bag.md","crew/antiphus.md","crew/barrow-on-aeaea.md","crew/burials-and-cenotaphs.md","crew/cave-party.md","crew/cenotaph-plan.md","crew/dissent-log.md","crew/elpenor.md","crew/eurylochus.md","crew/families-owed-news.md","crew/fleet-strength.md","crew/helmsmen.md","crew/how-to-tell-a-family.md","crew/ismarus-wine-ration.md","crew/losses/aeaea.md","crew/losses/cyclopes.md","crew/losses/ismarus.md","crew/losses/laestrygonians.md","crew/losses/scylla.md","crew/losses/thrinacia.md","crew/lotus-eaters.md","crew/oar-bench-rota.md","crew/oath-signatories.md","crew/open-questions.md","crew/perimedes.md","crew/polites.md","crew/promises-to-the-dead.md","crew/roll-calls/day-3.md","crew/roll-calls/day-10.md","crew/roll-calls/day-31.md","crew/roll-calls/day-99.md","crew/roll-calls/day-172.md","crew/roll-calls/day-206.md","crew/roll-calls/day-620.md","crew/roll-calls/day-1043.md","crew/roll-calls/day-1084.md","crew/roll-calls/day-1095.md","crew/scylla-six.md","crew/shares-owed.md","crew/ships/ship-01.md","crew/ships/ship-02.md","crew/ships/ship-03.md","crew/ships/ship-04.md","crew/ships/ship-05.md","crew/ships/ship-06.md","crew/ships/ship-07.md","crew/ships/ship-08.md","crew/ships/ship-09.md","crew/ships/ship-10.md","crew/ships/ship-11.md","crew/ships/ship-12.md","crew/sirens-wax.md","crew/standing-orders.md","crew/thrinacia-provisions.md","crew/watch-rota.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","ogygia/_index.md"],
  },
  {
    path: "ogygia/_index.md",
    title: "Ogygia",
    type: "index",
    created: "2019-03-02",
    updated: "2026-07-12",
    status: "active",
    tags: ["index"],
    summary: "The island, the cave and the workshop, after seven years.",
    body: `Seven years of records from Calypso's island: the cave, the garden, the shore, and the build that ends the stay.

59 records.

## Build

- [[ogygia/build/bulwarks]] — Wicker bulwarks
- [[ogygia/build/day-3647-the-order]] — Day 3,647 -- the order
- [[ogygia/build/day-3648-felling]] — Day 3,648 -- felling
- [[ogygia/build/day-3649-squaring]] — Day 3,649 -- squaring and pegging
- [[ogygia/build/day-3650-deck]] — Day 3,650 -- ribs, deck and bulwarks
- [[ogygia/build/day-3651-rigging]] — Day 3,651 -- mast, sail and the water's edge
- [[ogygia/build/departure-checklist]] — Departure morning
- [[ogygia/build/dimensions]] — Dimensions
- [[ogygia/build/launch-way]] — Rollers and levers
- [[ogygia/build/mast-and-yard]] — Mast and yard
- [[ogygia/build/plan]] — Build plan
- [[ogygia/build/planks]] — Planks
- [[ogygia/build/ribs-and-deck]] — Ribs and deck
- [[ogygia/build/sailing-directions]] — Sailing directions
- [[ogygia/build/steering-oar]] — Steering oar
- [[ogygia/build/timber-log]] — Timber log

## Records

- [[ogygia/debts]] — What I owe Calypso
- [[ogygia/the-offer]] — The offer

## Island

- [[ogygia/island/birds]] — Birds of the wood
- [[ogygia/island/cave]] — The cave
- [[ogygia/island/day-1095-landfall]] — Day 1,095 -- landfall
- [[ogygia/island/headland]] — The headland
- [[ogygia/island/hearth]] — The hearth
- [[ogygia/island/meadows]] — The meadows
- [[ogygia/island/shore]] — The shore below the cave
- [[ogygia/island/sightings]] — Sails sighted
- [[ogygia/island/springs]] — The four springs
- [[ogygia/island/survey]] — Walk-around survey
- [[ogygia/island/vine]] — The vine over the cave mouth
- [[ogygia/island/woods]] — The woods

## Routine

- [[ogygia/routine/clothing]] — Clothes
- [[ogygia/routine/day-count]] — Keeping the count
- [[ogygia/routine/evenings]] — Evenings at the hearth
- [[ogygia/routine/household]] — The household day
- [[ogygia/routine/loom]] — Her loom and her singing
- [[ogygia/routine/meals]] — What I eat

## Stores

- [[ogygia/stores/ballast]] — Ballast
- [[ogygia/stores/food-bag]] — The food bag
- [[ogygia/stores/not-taking]] — Things I will not take
- [[ogygia/stores/provisions-aboard]] — Provisions aboard
- [[ogygia/stores/water]] — Water
- [[ogygia/stores/wine]] — Wine

## Weather

- [[ogygia/weather/last-weeks]] — Weather log, the last four weeks
- [[ogygia/weather/launch-window]] — The launch window
- [[ogygia/weather/seasons]] — Seven years of seasons

## Workshop

- [[ogygia/workshop/adze]] — The adze
- [[ogygia/workshop/augers]] — The augers
- [[ogygia/workshop/cordage]] — Ropes
- [[ogygia/workshop/double-axe]] — The double axe
- [[ogygia/workshop/sail-cloth]] — Sail cloth
- [[ogygia/workshop/tool-return]] — Return the tools
- [[ogygia/workshop/tools]] — Tools lent

## Years

- [[ogygia/years/year-1]] — Year one on Ogygia
- [[ogygia/years/year-2]] — Year two on Ogygia
- [[ogygia/years/year-3]] — Year three on Ogygia
- [[ogygia/years/year-4]] — Year four on Ogygia
- [[ogygia/years/year-5]] — Year five on Ogygia
- [[ogygia/years/year-6]] — Year six on Ogygia
- [[ogygia/years/year-7]] — Year seven on Ogygia

## Other indexes

[[people/_index]] · [[knowledge/_index]] · [[studies/_index]] · [[journal/_index]] · [[decisions/_index]] · [[oaths/_index]] · [[omens/_index]] · [[ithaca/_index]] · [[voyage/log]] · [[crew/register]]

Everything here serves [[goals/return-to-ithaca]].`,
    links: ["goals/return-to-ithaca.md","voyage/ogygia/_index.md","ogygia/build/bulwarks.md","ogygia/build/day-3647-the-order.md","ogygia/build/day-3648-felling.md","ogygia/build/day-3649-squaring.md","ogygia/build/day-3650-deck.md","ogygia/build/day-3651-rigging.md","ogygia/build/departure-checklist.md","ogygia/build/dimensions.md","ogygia/build/launch-way.md","ogygia/build/mast-and-yard.md","ogygia/build/plan.md","ogygia/build/planks.md","ogygia/build/ribs-and-deck.md","ogygia/build/sailing-directions.md","ogygia/build/steering-oar.md","ogygia/build/timber-log.md","ogygia/debts.md","ogygia/island/birds.md","ogygia/island/cave.md","ogygia/island/day-1095-landfall.md","ogygia/island/headland.md","ogygia/island/hearth.md","ogygia/island/meadows.md","ogygia/island/shore.md","ogygia/island/sightings.md","ogygia/island/springs.md","ogygia/island/survey.md","ogygia/island/vine.md","ogygia/island/woods.md","ogygia/routine/clothing.md","ogygia/routine/day-count.md","ogygia/routine/evenings.md","ogygia/routine/household.md","ogygia/routine/loom.md","ogygia/routine/meals.md","ogygia/stores/ballast.md","ogygia/stores/food-bag.md","ogygia/stores/not-taking.md","ogygia/stores/provisions-aboard.md","ogygia/stores/water.md","ogygia/stores/wine.md","ogygia/the-offer.md","ogygia/weather/last-weeks.md","ogygia/weather/launch-window.md","ogygia/weather/seasons.md","ogygia/workshop/adze.md","ogygia/workshop/augers.md","ogygia/workshop/cordage.md","ogygia/workshop/double-axe.md","ogygia/workshop/sail-cloth.md","ogygia/workshop/tool-return.md","ogygia/workshop/tools.md","ogygia/years/year-1.md","ogygia/years/year-2.md","ogygia/years/year-3.md","ogygia/years/year-4.md","ogygia/years/year-5.md","ogygia/years/year-6.md","ogygia/years/year-7.md","people/_index.md","knowledge/_index.md","studies/_index.md","journal/_index.md","decisions/_index.md","oaths/_index.md","omens/_index.md","ithaca/_index.md","voyage/log.md","crew/register.md"],
  },
];
