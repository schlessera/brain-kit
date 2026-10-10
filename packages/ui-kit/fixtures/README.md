# Fixture world — the Odyssey

A complete, self-contained fake brain owned by **Odysseus**, ten years out of
Troy and about to push a raft off the beach at Ogygia. Every component in
`@schlessera/brain-ui-kit` renders against this data, in Storybook, in the
visual-regression baselines, and in anything that ends up on the website.

This is the same fictional world as
[`packages/core/fixtures/corpus/`](../../core/fixtures/README.md). The
[2026-09-30 ruling](../../../docs/decisions/example-corpus.md) supersedes
D18/D19's former separate-persona and no-shared-content rules. The core corpus
preserves engineered retrieval and audit cases; this directory stages
presentation data with a closed link graph. Keep their technical shapes
separate where useful, while sharing the cast, timeline and canonical facts.

## The tone rule

**Ancient problems, modern organisational tools.** Odysseus has a smartphone;
everything else is mythologically grounded. No modern job titles, no invented
startup, no "Project Atlas". Agents keep their functional names
(`researcher`, `note-filer`, `source-watch`, `ledger`) because they are the
modern half of the collision; what they are filing is an oath sworn on a beach.

The humour comes from the collision being played straight. "Call Penelope —
overdue by 10 years" lands *because* the six hundred names in the crew ledger
beside it are counted honestly. **Parody is the failure mode here**, because a
fixture set that winks at the reader stops being usable for a screenshot.

## Reference date and the fixed "now"

**Every date in this world is derived from `2026-07-12`** — the same reference
date `packages/core/fixtures/corpus/` pins. Both technical fixture sets use this world and clock, so dated observations
and presentation state can be compared without inventing another timeline.

> **Story and test authors: import `REFERENCE_DATE` / `REFERENCE_INSTANT` from
> `fixtures/time.ts`. Never `new Date()`.**

The pinned instant is **06:40 on Ogygia (UTC+2)** — the hour the morning digest
lands, which is the screen the whole world is staged for. Ithaca is an hour
ahead, and `TIMEZONE_FOOTNOTE` is the line every "resolves at" time carries
because of it.

| Constant | Value | Why |
|---|---|---|
| `REFERENCE_DATE` | `2026-07-12` | the pinned "now" |
| `TROY_FELL` | `2016-07-12` | ten years earlier, to the day |
| `DAYS_SINCE_TROY` | `3652` | ten years of coming back |
| `DAYS_ON_OGYGIA` | `2557` | seven years, as Book VII states |
| `DAYS_ON_AEAEA` | `365` | one full year, as Book X states |
| `YEARS_AWAY` | `20` | ten at Troy and ten returning |
| `RAFT_DEADLINE` | `2026-07-29` | seventeen days of open water, Book V |

**On the day count.** The brief suggested `2,914`. It does not close: seven
years on Ogygia plus a year on Aeaea is 2,922 days before a single day of
sailing. `3,652` lets both stated durations stand and earns the line the world
most wants to say — *the war took ten years, and so has coming back*. The
suggested number survives as `journal/day-2914.md`, a real entry from year five
on Ogygia. Beyond those durations the poem dates almost nothing, so the day
numbers on each place are **ordered and plausible, not a reconciliation of
Homer's arithmetic**, which does not close either.

## Modules

| Module | Holds | Feeds |
|---|---|---|
| `types.ts` | the vocabulary: world entities, plus one interface per array-valued prop in the design | everything |
| `time.ts` | the pinned clock and four date helpers | everything dated |
| `people.ts` | 16 people, their standing and their relationship notes | `ContactCard`, `ListRow`, `RelatedFiles` |
| `places.ts` | 20 real coordinates, the voyage polyline, three map scenes | `MapView` |
| `place-maps.ts` | six `map` block scenes: places, the plan `planPlaces` makes of them, and the geometry each frame is drawn over | `PlaceMap`, `PlaceList` |
| `projects.ts` | one goal, four projects, five threads, the strait decision | `StepList`, `ComparisonTable`, `Label` |
| `notes.ts` | 18 documents across six kinds, with a closed link graph | `QuoteCard`, `CodeBlock`, `Chip(kv)`, `SearchResultCard` |
| `events.ts` | overnight timeline, today's schedule, reminders, notifications | `TimelineList`, `ScheduleList`, `DigestCard`, `NotificationCard` |
| `runs.ts` | four agent runs, traces, lanes, the orbit, the capability receipt | `AgentOrbit`, `AgentRunCard`, `TraceSteps`, `LaneChart`, `Receipt` |
| `actions.ts` | all seven action kinds, all six queue states, all five empty states | `ActionCard`, `AskUserCard`, `ApprovalCard`, `QueueItemRow`, `EmptyState` |
| `files.ts` | the tree, the attachments, the tab bar, the launchers | `FileRow`, `AttachmentRow`, `TabBar`, `LinkPreviewCard` |
| `money.ts` | three ledgers: agent spend, the crew, the estate | `Meter`, `BarList`, `TrendChart`, `DataTable` |
| `search.ts` | one query, three tabs: results, graph, timeline | `SearchResultCard`, `GraphView`, `TimelineList`, `SuggestionChips` |
| `week.ts` | the weekly review: run counts, what changed, what carried | the §11.3 screen — `FilterRow`, `ListRow`, `ActionCard`, `Callout` |
| `sessions.ts` | one working session per tracker state, the pinned age clock, a long title | `SessionStrip`, `ComposerRow` |
| `follow-ups.ts` | five pending follow-ups in send order, one with a label, and a long prompt | `PendingFollowUps`, `ComposerRow` |
| `index.ts` | namespace re-exports and the `odyssey` aggregate | a story that composes four modules |
| `library/` | 400+ whole Markdown records and the twelve ship rosters ([README](library/README.md)) | the website demo's file tree, search and graph |

`types.ts` imports `Tone`, `ButtonTone` and `IconName` from `../src` rather
than restating them, so a fixture cannot name a colour or an icon the
components do not have. The **kit-shape** interfaces beside them (`StatTile`,
`TraceStep`, `MapPin`, …) are a deliberate, temporary mirror of the design's
`data-props` blocks; delete each one and re-point it at `../src` as its
component ships.

## The cast

| Person | Role | Where |
|---|---|---|
| Penelope | wife, holding Ithaca | Ithaca |
| Telemachus | son, travelling for news | Sparta |
| Athena | patron | — |
| Poseidon | holds the grievance | — |
| Calypso | host | Ogygia |
| Circe | gave the route | Aeaea |
| Teiresias | seer, consulted once | the Acheron |
| Polyphemus | the original mistake | land of the Cyclopes |
| Eurylochus | second in command | Thrinacia (dead) |
| Elpenor | crew | Aeaea (dead) |
| Laertes | father | Ithaca |
| Eumaeus | swineherd | Ithaca |
| Antinous | chief suitor | Ithaca |
| Nestor | knew the fleet | Pylos |
| Menelaus | has the first real news | Sparta |
| Argos | dog, twenty years old | Ithaca |

## The geography is real

`MapView` projects with Web Mercator and computes its scale bar from
metres-per-pixel at the view's latitude, so an invented coordinate draws a
wrong map with a confidently wrong scale bar under it. **Every coordinate below
was read from the English Wikipedia article named beside it**, through the
MediaWiki `prop=coordinates` API — the article's own geotag, not a paraphrase.

Mythical places are pinned at their **conventional candidate sites**. That is a
stated convention, not a claim: Ogygia is not Gozo, but Gozo is where people
have put Ogygia for a very long time, and it is a real island at a real
latitude.

| Place | Site | lat, lon | Source article |
|---|---|---|---|
| Ithaca | Vathy, Ithaki | 38.3647, 20.7202 | Vathy, Ithaca |
| Troy | Hisarlik | 39.9575, 26.2389 | Troy |
| Ismarus | Maroneia, Thrace | 40.9000, 25.5167 | Maroneia |
| Cape Malea | Cape Maleas, Laconia | 36.4381, 23.1986 | Cape Maleas |
| Lotus-eaters | Djerba, Tunisia | 33.8000, 10.8833 | Djerba |
| Cyclopes | Aci Trezza, Sicily | 37.5636, 15.1614 | Aci Trezza |
| Aeolia | Lipari | 38.4667, 14.9500 | Lipari |
| Laestrygonians | Bonifacio, Corsica | 41.3868, 9.1569 | Bonifacio, Corse-du-Sud |
| Aeaea | Mount Circeo, Lazio | 41.2333, 13.0500 | Mount Circeo |
| House of the dead | Necromanteion of Acheron | 39.2362, 20.5345 | Necromanteion of Acheron |
| Sirens | Li Galli (Sirenuse) | 40.5810, 14.4330 | Sirenuse |
| Scylla | Scilla, Calabria | 38.2507, 15.7190 | Scilla, Calabria |
| Charybdis | Faro Point (Capo Peloro) | 38.2647, 15.6508 | Faro Point |
| The strait | Strait of Messina | 38.2458, 15.6325 | Strait of Messina |
| Thrinacia | Mount Etna, Sicily | 37.7550, 14.9950 | Mount Etna |
| Ogygia | Gozo, Malta | 36.0500, 14.2500 | Gozo |
| The cave | Ramla Bay, Gozo | 36.0620, 14.2830 | Ramla Bay |
| Scheria | Corfu (Kerkyra) | 39.6000, 19.8700 | Corfu |
| Pylos | Pylos, Messenia | 36.9139, 21.6964 | Pylos |
| Sparta | Sparta, Laconia | 37.0819, 22.4236 | Sparta |

`voyageRoute` is a 15-point `[lon, lat]` polyline, Troy to Ogygia, 5,453 km of
sailing. `plannedRoute` is the 788 km that has not happened yet. Both are
`[lon, lat]`, in that order, because `MapView` projects `c[0]` as longitude.

## Invariants

Asserted in [`../tests/fixtures.test.ts`](../tests/fixtures.test.ts). Each one
is the kind of thing that decays silently.

**Determinism**

- No fixture module contains `Date.now()`, `new Date()`, `Math.random(` or
  `fetch(`. Every date comes from `REFERENCE_DATE` via the helpers in
  `time.ts`, and every time of day is a literal string — a fixture formatted
  through `Intl` renders `06:40` in one locale and `6:40 AM` in another, and a
  visual-regression baseline cannot survive that.
- Ids are stable and hand-written. Nothing is generated at module load.

**Geography**

- Every coordinate is inside the Mediterranean basin (lat 30–46, lon −6–37).
- Every place names the Wikipedia article its coordinate came from.
- Exactly one place has `kind: "home"`.
- Every point in both polylines passes the same basin check, which is what
  catches a `[lat, lon]` transposition — at these latitudes the two ranges
  overlap, so a spot check does not.
- Every map pin's coordinate belongs to a place in `places`.
- No place's `day` exceeds `DAYS_SINCE_TROY`.

**Cross-references**

- Ids are unique across every entity table.
- Paths are unique within each table. Where a path appears in both `people` and
  `notes` it is the **same document**: the note's `kind` is `person`, it names
  that person, and its `staleDays` matches.
- Every wiki-link in `notes[].links` resolves to a path that exists in
  `notes`, `people`, `projects` or the goal. **There are no unresolved links
  and no orphans** — the opposite of the core corpus, deliberately.
- Every `PersonId` / `PlaceId` / `ProjectId` / `ThreadId` a record names
  exists.
- Every graph edge indexes a real node.
- Every note tag is one of the five in `tags`.

**The ledgers balance**

- 600 men out of Troy in 12 ships; `crewLosses` sums to exactly 600; 1
  survivor; 0 ships returned.
- The weekly spend bars and the seven daily totals both sum to
  `weekSpendTotalCents`.
- The weekly review closes on itself: decisions offered plus digests is the run
  count, answered plus carried is the decisions offered, the carried list has
  `weekCarriedCount` rows, and `weekAnsweredPct` is computed rather than typed.
- `runSpendCents` is the sum of the runs' `cents` (`$0.22`).
- `folderCounts` sums to 4,812 — the document count the first-run screen and
  the orbit core both quote — and `journal/` holds exactly one entry per day
  since Troy.

**Coverage the design asks for**

All seven `ActionCard` kinds, all six `QueueItemRow` states, all five
`EmptyState` variants, all four run states, all four attachment kinds, all
three notification densities. Each progress `StepList` has exactly one
`current` step.

**Reserved identifiers only**

- Phone numbers are in the NANP `555-0100`–`555-0199` block, reserved for
  fiction. Gods and the dead have `null`, not an invented number.
- Email addresses are on `example.com` (RFC 2606).
- Hostnames are `example.com` or under `.invalid` (RFC 2606). The failing
  source is `winds.example.invalid`, which returns NXDOMAIN by construction —
  that is *why* the dead-letter story works.
- **No IBAN appears anywhere, and none should be added.** ISO 13616 reserves
  no range for testing, so any mod-97-valid IBAN could belong to a live
  account. A world with no bank accounts sidesteps it entirely.

## Hazards when adding to this world

1. **Bird omens.** The poem is full of them and one of the leakage gate's
   banned tokens is a plumage-colour word. Describe birds by what they are
   doing — "an eagle carrying a goose" — never by their colouring. Run
   `bun scripts/check-leakage.ts` before you finish; if it trips, **do not
   quote the offending string into any file**, rephrase.
2. **Coordinates.** Verify each one against the article and cite it in the
   `source` field. A plausible-looking invented coordinate is worse than an
   obviously wrong one, because the scale bar underneath it will still look
   authoritative.
3. **Numbers that have to close.** The crew ledger, the folder counts and the
   spend are all asserted. Adding a landfall means adding its losses.
4. **Tone.** Before adding a line, ask whether it would still read as serious
   with the joke removed. If the answer is no, it is parody and it does not
   belong in a screenshot.
5. **Core scenario invariants.** Changes to `packages/core/fixtures/` preserve
   its engineered cases and document their semantic counterparts, following
   [the corpus ruling](../../../docs/decisions/example-corpus.md).

## Why the kit-purity gate does not cover this directory

`scripts/check-kit-purity.ts` enforces **D13**, which is a claim about
*components*: props in, callbacks out, nothing ambient. Widening its glob to
`fixtures/` would conflate that with a different property — determinism — while
still missing the three bans that actually matter here, none of which the
purity gate checks (`Date.now()`, `new Date()`, `Math.random(`). The fixture
test covers all of them, and `fetch(` as well, so the one purity rule that does
transfer is not lost.
