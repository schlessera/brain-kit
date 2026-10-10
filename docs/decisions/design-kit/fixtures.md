# Design kit — Example fixtures

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-15--fixture-data-must-be-wholly-artificial-maintainer"></a>

## 2026-09-15 — fixture data must be wholly artificial (maintainer)

Requirement: **every piece of test, Storybook, CI, local-dev and example data is
artificial.** No real personal data and nothing from the real knowledge base, at
any point, in any of those places. Options researched in
a fixture-world options pass; the world chosen was the Odyssey (D19).

Three findings that are settled regardless of which world wins.

<a id="the-design-drop-already-ships-real-brands"></a>

### The design drop already ships real brands

Its mock content is not neutral. `Nordwind` — the client name, used 9 times — is
a real Moscow-headquartered airline (verified). `LX Factory` is a real Lisbon
venue and the design uses its true coordinates. `daily.dev` and `Tailscale` are
real products, and AGENTS.md separately bans tailnets as personal
infrastructure. **These get replaced during the port, not after.** A porting
agent copying mock content faithfully would carry all four into a published
package.

<a id="the-leakage-gate-constrains-vocabulary-not-names"></a>

### The leakage gate constrains VOCABULARY, not names

Measured, not guessed: candidate strings were run through the repo's own
`leakagePattern()`. **9 of 23 tripped, and not one was a character name.** Every
collision came from prose register — what a world lets you *describe*, not who
it lets you name. Matching is case-insensitive substring, per line, so a banned
token only has to appear *inside* a longer word: base forms pass where their
inflections trip.

The collision classes, named without quoting the strings (quoting them here
would fail the gate — that already happened once):

- plumage and colour description in wildlife prose — one banned token is
  standard ornithological vocabulary and appears in official species common
  names
- seasonal-singing words in their `-ed` / `-er` / `-ers` inflections, though not
  in base or plural form
- one Stuart/Restoration period adjective
- heraldic and fantasy bestiary terms, including as a codename
- one common French masculine given name

**Style rules that follow, and they apply to all fixture prose forever:** prefer
plain sightings over plumage description; avoid Stuart-era and heraldic
register; check any French given name; and run a candidate cast and its
vocabulary through the gate *before* adopting it, not after writing the fixtures.

This also inverts the earlier assumption that any world with a clean canon is
safe. The exposure is uneven and it is about subject matter: a world whose
persona does seasonal wildlife survey work is badly exposed even though its cast
is invented.

<a id="the-corpus-cost-model-is-the-opposite-of-what-we-assumed"></a>

### The corpus cost model is the opposite of what we assumed

Measured against `packages/core/fixtures/`:

- **Renaming the persona is cheap.** 33 files mention it, but 13 are tests whose
  uses are self-contained literals (an RSS `<dc:creator>`, an
  `x-forwarded-user` header, a `{name, role}` object) rather than assertions
  about corpus content. `brain.db` is **not tracked**. There are no snapshot or
  golden files anywhere.
- **Adding to the corpus is expensive.** `packages/core/fixtures/README.md`
  documents *global invariants*, not sample documents: exactly two intentional
  unresolved links; exactly one orphan (`notes/loose-idea.md`), which the orphan
  test depends on; engineered basename ambiguity; and staleness windows computed
  against a pinned date with asserted day counts. Adding people, invoices and
  venues creates new orphans, new unresolved links and new ambiguous basenames —
  each one an existing assertion.
- **A period world would force re-dating the entire corpus.** The pinned 2026
  reference date is load-bearing for every staleness, index-lag and propagation
  assertion, and an 1872 or 1889 setting cannot host it. That cost is larger
  than any of the IP risks.

> **2026-09-30 — Corpus ruling.** D18’s separate-persona and no-shared-content restrictions are historical.
> [One Odysseus world](../example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

**D18 — the corpus and the kit fixtures are separate, and neither moves the
other.** `packages/core/fixtures/corpus/` stays exactly as it is, persona
included: zero test churn, invariants intact, pinned date intact. `ui-kit` gets
its own fixture world under `packages/ui-kit/fixtures/`, free to be whatever we
choose, because nothing asserts global invariants over it. The two never meet.

This also dissolves the apparent conflict with AGENTS.md's "Alex Example" hard
rule: that rule governs the corpus, which is unchanged. If the kit's world uses
different names, AGENTS.md gains a sentence scoping the personas — a deliberate
edit in the same commit, not a silent divergence.

<a id="2026-09-15--d19-the-fixture-world-is-the-odyssey-maintainers-choice"></a>

## 2026-09-15 — D19: the fixture world is the Odyssey (maintainer's choice)

**Decided: Odysseus is the owner of the demo second brain.** Used everywhere
artificial data is needed — `ui-kit` fixtures, Storybook, website copy,
screenshots, demo videos.

<a id="why-it-beats-every-researched-option"></a>

### Why it beats every researched option

- **IP risk is the floor and then some.** Homer is public domain in every
  jurisdiction on earth, with no estate, no licensing body, and no trademark on
  the cast. This is strictly safer than the RFC-reserved option, which still
  needs care around company names, and far safer than the "documented company"
  placeholders, where `CONTOSO` is a live Microsoft registration whose recited
  services literally cover simulated case studies.
- **The graph already exists.** People with real relationships, places, goals,
  conflicts, journeys, promises, memories, and — the useful part — a great many
  *unresolved* problems. The story is structurally a backlog: hostile
  stakeholders, dependencies, travel logistics and consequential bad decisions.
  Demo data can be dramatic without looking arbitrary.
- **Instantly and unmistakably fictional**, which is the property that makes
  real data leaking in obvious.
- **The geography is real.** Ithaca, Troy/Hisarlik and the Strait of Messina are
  actual places with actual coordinates, so `MapView`'s Web Mercator projection
  and computed scale bar draw a correct map. Mythical locations have
  conventional real-world candidate sites (Ogygia → Gozo, Scylla → Scilla in
  Calabria), so even those can be pinned honestly.
- **It hosts 2026 dates without strain.** Unlike Baker Street 1889 or Verne
  1872, the anachronism *is* the conceit, so no fixture needs re-dating and the
  corpus's pinned-date problem never arises.

<a id="gate-check--run-before-adopting-per-the-standing-rule"></a>

### Gate check — run before adopting, per the standing rule

139 candidate strings were probed through the repo's own `scanText()` from a
script kept outside the scanned tree. **125 Odyssey strings across cast, gods,
creatures, places and nautical vocabulary: all clear.** The only two trips were
control strings planted deliberately to prove the probe actually detects
something.

One residual hazard worth naming, because the Odyssey walks right past it: the
poem is full of **bird omens** — eagles, a hawk, the geese in Penelope's dream.
One banned token is a plumage-colour word. Describe birds plainly ("an eagle
carrying a goose"), never by plumage colour.

<a id="the-tone-rule"></a>

### The tone rule

**Ancient problems, modern organisational tools.** Odysseus with a smartphone,
everything else mythologically grounded. No modern job titles, no invented
startup, no "Project Atlas". The humour comes from the collision being played
straight — "Call Penelope — overdue by 10 years" works precisely because the
surrounding data is serious. **Parody is a failure mode here**, because a
fixture set that is winking at the reader stops being usable for screenshots
and demo videos.

Mapping (from the maintainer's brief):

| Feature | Fixture content |
|---|---|
| Goal | Return to Ithaca |
| Project | Get home after Troy |
| People | Penelope, Telemachus, Athena, Circe, Calypso, Poseidon |
| Places | Ithaca, Troy, Aeaea, Ogygia, land of the Cyclopes |
| Open loops | Crew safety, Poseidon's anger, supplies, route home |
| Notes | "Do not tell Polyphemus my real name" |
| Tasks | Repair mast, replenish water, avoid Scylla, check winds |
| Journal | "Day 2,914 away from home" |
| Reminders | "Tie me to the mast before the Sirens" |
| Knowledge | Sirens — dangerous vocal lure; wax recommended |
| Decisions | Scylla vs Charybdis |
| Relationships | Athena — ally, intervention unpredictable |
| Search | "Where did Circe warn me about Scylla?" |
| AI summary | "What happened since leaving Troy?" |
| Maps | Route across the Mediterranean |
| Attachments | Charts, sketches, ship manifests |
| Tags | #ithaca #crew #gods #danger |

> **2026-09-30 — Corpus ruling.** D19’s former UI-only scope is historical.
> [One Odysseus world](../example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

Scope: `packages/ui-kit/fixtures/` per D18. `packages/core/fixtures/corpus/` and
its "Alex Example" persona are untouched, so no test churn and no invariant
breakage. AGENTS.md gains a sentence scoping the two personas — corpus vs kit —
in the commit that introduces the world.

