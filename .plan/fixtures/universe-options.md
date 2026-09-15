# Fixture universe options

Every byte of test data, Storybook data, local-dev data and example data in this
repo must be artificial. This document proposes six candidate worlds to supply
that data coherently, assesses the IP risk of each with citations, and
recommends one.

**Date of research: 2026-09-15.** Copyright terms move on 1 January every year;
re-check any term claim below before relying on it after 2026-12-31.

Nothing here is legal advice. It is a risk assessment with sources, written so
the maintainer can make the call.

---

## 1. What the fixture world actually has to carry

Two sources define the requirement.

**The design drop** (`.plan/design/catalog.md`, `.plan/design/screens.md`)
describes 56 components across 11 sections and 20 mobile screens. Its mock data
is a freelance consultant-and-speaker: clients, a day rate, invoices in euros,
conference talks, Lisbon venues, deadlines, and an agent that files notes and
occasionally fails. `MapView` projects **genuine coordinates** through Web
Mercator and computes a scale bar from metres-per-pixel at the view's latitude,
so its locations must be real places even when the story around them is not.

**The existing corpus** (`packages/core/fixtures/corpus/`, 33 files) is already
a coherent world, not a bare name. Its README says the persona is deliberately
*"not a software/speaking persona, so tests don't accidentally encode the
maintainer's real domains."* Dates are pinned to a fixed reference date rather
than the wall clock.

So there is a tension worth naming before choosing a world: **the corpus was
built to avoid the consultant frame, and the design drop is built entirely
inside it.** Whichever world wins, the kit's mock content should move toward the
corpus's discipline rather than the other way round.

### The coverage checklist

| Dimension | Needed for | Corpus today |
|---|---|---|
| People with roles + relationships | `ContactCard`, `GraphView`, mentions | absent |
| Prior conversations to cite | `QuoteCard`, `RelatedFiles` | absent |
| Organizations (clients, vendors, venues) | `GraphView` legend, `DataTable` | absent |
| Places with **real** lat/lon | `MapView` | absent |
| Projects + events with deadlines | `ActionCard`, `ScheduleList`, `TimelineList` | partial (`next_review`) |
| Documents: paths, frontmatter, quotes, diffs | `PathRef`, `DiffBlock`, `FileRow` | **good** |
| Money: invoices, rates, budgets, currency | `BarList`, `Meter`, `StatTiles`, `Receipt` | absent |
| Calendar entries incl. conflicts | `ScheduleList` | absent |
| Agent-run content: tasks, tools, failures | `AgentRunCard`, `TraceSteps`, `QueueItemRow` | absent |
| External material + untrusted origin | `LinkPreviewCard`, purple provenance chips | absent |

### Two constraints that bind every candidate

1. **The leakage gate has a denylist of personal strings**
   (`scripts/check-leakage.ts`). It includes two pet/character names and a
   given name alongside the maintainer's surname and infrastructure. Any
   candidate cast must be checked against that list before adoption — run
   `bun scripts/check-leakage.ts` on a branch that contains the proposed names.
   Do not assume a fictional name is safe because it is fictional. This turned
   out to be the sharpest constraint in the whole evaluation and it does not
   work the way it first appears — **§3 has the measured results**, including
   which worlds it actually threatens and why no canon cast is the problem.
2. **A name that feels invented may not be.** The design drop's mock client is
   `Nordwind`. *Nordwind* is the live international brand of a real airline
   (legally Severny Veter LLC), which states in its own brand guidelines that
   the mark is its main brand element and may not be modified
   ([Nordwind Airlines corporate style](https://nordwindairlines.ru/en/corp-style),
   [Wikipedia](https://en.wikipedia.org/wiki/Nordwind_Airlines)). This is the
   exact failure mode the fixture policy exists to prevent, and it is already in
   the tree we are about to port from.

---

## 2. The legal frame, stated once

Four principles decide every row of the risk table. They are not repeated in
each proposal.

**(a) Copyright terms differ by jurisdiction, and we publish to both.**
In the US the term for published works is 95 years from publication: on
2026-01-01, works first published in **1930** entered the public domain
([Duke CSPD, Public Domain Day 2026](https://web.law.duke.edu/cspd/publicdomainday/2026/),
[Public Domain Review](https://publicdomainreview.org/features/entering-the-public-domain/2026/)).
In the EU and UK the term is life of the author plus 70 years. The two can
diverge by decades, in either direction. A world is only safe for an npm package
and a public website if it clears **both**.

**(b) A work can be partly in the public domain.** Sherlock Holmes is the
canonical example, and it has now resolved: the twelve stories in *The
Case-Book of Sherlock Holmes* (1927) were the last under US copyright, so the
**entire canon has been in the US public domain since 2023-01-01**
([Duke CSPD 2023](https://web.law.duke.edu/cspd/publicdomainday/2023/),
[PBS NewsHour](https://www.pbs.org/newshour/arts/sherlock-holmes-classic-tales-and-songs-enter-public-domain-in-2023)).
UK copyright expired much earlier — the author died in 1930, so life+70 put the
canon in the UK/EU public domain on **2001-01-01**. The split that made Holmes
famous as a teaching case no longer exists. **Check the current state of any
"partially public domain" claim; several are stale.**

**(c) Trademark survives copyright, but it is scoped to goods and services.**
Character names can carry trademark rights even when the underlying work is
public domain: EUIPO's Opposition Division has held that *"Characters of fiction
may be trade marks, there is nothing to exclude them from acting as such"*
([CSY IP](https://csy-ip.com/copyright-the-public-domain-and-retaining-protection-for-fictional-characters-via-trade-marks/)).
But a trademark is *"always connected to the specific goods or services sold to
customers with that trademark"*
([USPTO, scope of protection](https://www.uspto.gov/trademarks/basics/scope-protection)),
and the cornerstone of infringement is **likelihood of confusion as to source**
([Cornell LII](https://www.law.cornell.edu/wex/infringement_(of_trademark))).
Fixture rows inside a library are not offered as goods, do not identify the
source of our software, and no consumer could think otherwise. That is why the
doctrinal risk of literary names is genuinely low.

**(d) The practical risk is not the merits — it is who the counterparty is.**
A rights-holder with a history of asserting claims can impose real cost on a
solo maintainer of an MIT project regardless of who would win. This is the axis
on which the proposals below actually differ, and it is why the "safe corporate
placeholder" option scores *worse* than two Victorian novels.

---

## 3. The leakage gate is a vocabulary constraint, not a name constraint

`scripts/check-leakage.ts` matches a fixed list of personal strings,
**case-insensitively, as substrings, per line, over the whole tree including
untracked files, with no exempt directories.** Two entries on that list are
ordinary English words rather than obviously personal tokens. Read the
`PATTERNS` array directly before adopting any cast; the strings there are split
across concatenations so the script does not trip its own gate, and the same
discipline applies to anything written about them.

Substring matching is what makes this sharp. A banned token does not need to
appear as a standalone word — it only has to appear *inside* one. That turns
several innocuous vocabularies into hazards.

### What was actually tested

Candidate vocabulary for each world was run through the repo's own
`leakagePattern()` rather than eyeballed. Results:

| Vocabulary | Example candidate | Result |
|---|---|---|
| Canon cast — Holmes | the principal characters and client names | **clear** |
| Canon cast — Verne | the principal characters and the elephant | **clear** |
| Canon cast — corporate placeholders | the full documented-companies list | **clear** |
| Canon cast — coined relay practice | the three invented principals | **clear** |
| Reserved-identifier cast + values | `Example` surnames, TEST-NET, `555-01xx` | **clear** |
| Wildlife plumage description | a standard colour descriptor used across official species common names and routine field-guide prose | **TRIPS** |
| Wildlife, plain sighting log | `barred owl`, `Buff-breasted Sandpiper` | clear |
| Seasonal singing, `-ed`/`-er`/`-ers` inflections | agent/celebrant nouns and past tense | **TRIPS** |
| Seasonal singing, base and plural | the singular and plural nouns | clear |
| Stuart/Restoration period adjective | the era adjective | **TRIPS** |
| Heraldic and fantasy bestiary | one specific winged beast | **TRIPS** |
| Heraldic, other beasts | `griffin rampant` | clear |
| French given names | one common masculine given name | **TRIPS** |
| French names, canon | `Jean Passepartout` | clear |
| Aerospace mission codename | the same winged beast as a codename | **TRIPS** |

Nine of twenty-three candidate strings tripped it. **Not one was a canon
character name.** Every collision came from the surrounding prose register:
what the world lets you *describe*, not who it lets you name.

### What that means per proposal

| Proposal | Canon | Prose exposure | Verdict |
|---|---|---|---|
| 4.1 Eighty Days | clear | **Medium.** French setting; one common French given name is banned, so the invented-character name pool needs filtering. Heraldry at the club is a minor secondary risk. | Adapt: filter the French name pool. |
| 4.2 Baker Street | clear | **Medium.** Victorian London invites the seasonal-singing vocabulary (the canon even has a Christmas story) and the period adjective; gentry settings invite heraldry. All three trip. | Adapt: ban three word families in the fixture style guide. |
| 4.3 Documented Companies | clear | **Low.** Corporate placeholder prose has no natural route to any banned token. | No gate issue (its problem is trademark). |
| 4.4 Cedar Hollow extended | clear | **HIGH — the worst of the six.** The persona runs *seasonal wildlife surveys*, and the banned colour descriptor is standard ornithological vocabulary: it is part of several official species common names and appears routinely in plumage description. The corpus already contains an owl note. A wildlife log is the single most natural way to grow this world and the single most likely way to redden CI. | Adapt with a hard rule — see below. |
| 4.5 Reserved World | clear | **None.** It has no descriptive prose to expose. | Structurally immune. |
| 4.6 Relay Practice | clear | **Low–medium.** Coined names are filterable by construction, but aerospace convention names missions after mythical creatures, and one such creature is banned. | Adapt: filter the codename pool. |

**No proposal is disqualified.** Every collision is in vocabulary we choose, not
in canon we inherit. But the exposure is real, it is unevenly distributed, and
it lands hardest on the recommended world — which is stated plainly rather than
buried, and carries a mitigation in §7.

### The rule that follows

Write this into the fixture style guide regardless of which world wins:

1. **No species-description prose.** Wildlife, plants and livestock appear as
   plain sightings (`barred owl, north loop, 06:40`), never with colour,
   plumage or morphology description. This single rule removes the entire
   highest-risk category.
2. **No heraldry or mythical bestiary**, in any world, including as codenames,
   project names or mascot names.
3. **No seasonal-singing vocabulary** in its agent-noun or past-tense
   inflections.
4. **Filter every invented person-name pool through the gate before use** —
   not after, and not by inspection. The probe is four lines: import
   `leakagePattern()` from `scripts/check-leakage.ts` and test the candidate
   list.
5. **Treat the denylist as growing.** It is a list of the maintainer's personal
   strings and will gain entries. A world whose natural vocabulary sits close to
   that list is fragile against additions it cannot anticipate. This is a
   standing argument for the reserved-identifier discipline in §6, which is
   orthogonal to whatever gets added later.

---

## 4. The proposals

### 4.1 — "Eighty Days": the Verne travel bureau

**The world.** The logistics practice that services a circumnavigation wager
made at a London club in 1872 — booking passages, settling accounts in four
currencies, and filing dispatches from each port. The client is on the move, the
deadline is absolute, and a suspicious investigator is shadowing the account.

**Worked examples**

- *People.* **Phileas Fogg** — client, principal of the wager, replies in one
  line or not at all. **Jean Passepartout** — operations; books the passages and
  keeps the ledger. **Detective Fix** — external investigator with an
  undisclosed agenda; every document he supplies is the untrusted-origin story.
- *Organizations.* **The Reform Club** (the wager's venue and counterparty);
  **Mongolia Line** (the steamer operator — use the ship name from the novel,
  never the real historical shipping company).
- *Places (real coordinates).* Pall Mall, London — `51.5069, -0.1331`
  ([Wikipedia](https://en.wikipedia.org/wiki/Pall_Mall,_London)). Port Said,
  Egypt — `31.2625, 32.3061`
  ([Wikipedia](https://en.wikipedia.org/wiki/Port_Said)).
- *Project with a deadline.* **The wager** — return to the Reform Club by
  1872-12-21 21:00. 80 days, no extension, with a progress meter that is the
  most natural `Meter` fixture of any proposal here.
- *File paths.* `clients/fogg/wager-terms.md`,
  `passages/1872-10-09-suez.md`, `talks/reform-club-brief.md`
- *Quotable sentence.* "The Mongolia is due at Suez on the ninth; the ledger
  says the eleventh, and one of those is wrong."
- *Invoice.* Draft no. 0100 — Mongolia Line, Suez agent — £550, drawn
  1872-10-09, settled 1872-10-11 at a £12 exchange loss.
- *Agent-run failure.* `source-watch` failed — `WebFetch bradshaws timetable
  returned the 1874 edition; the premise "Suez, 9 Oct" is unverified. 2 actions
  blocked.`

**IP and trademark.** The author died in 1905. Life+70 put the works in the
EU/UK public domain in **1976**; US publication in 1872–1873 is far outside any
subsisting US term. The novel is **unambiguously public domain worldwide**
([summary](https://www.quora.com/Are-the-books-written-by-Jules-Verne-in-the-public-domain-such-that-they-can-be-distributed-commercially)).
One live mark to know about: **Phileas Fogg is a real UK snack brand**, founded
1982, now owned by KP Snacks
([Wikipedia](https://en.wikipedia.org/wiki/Phileas_Fogg_snacks),
[KP Snacks](https://www.kpsnacks.com/news/show/out-of-this-world-sales-with-new-range-from-phileas-fogg)).
That registration lives in food classes and our use is neither food nor
source-identifying, so under principle (c) it does not reach us — but it is a
reminder to clear each name, not the world.
France recognises perpetual moral rights (attribution and integrity) held by
heirs; these do not restrict commercial use, only false attribution — which we
are not doing.

**Risk: LOW.** Publishable in an MIT npm package and on a public Storybook.

**Fit.** Strong in an unexpected way. A wager is a deadline, passages are
invoices, ports are places with real coordinates, and a shadowing investigator is
a ready-made untrusted-origin narrative. What it does **not** have is a day
rate, a client pipeline, or a talk circuit.

**Recognisability.** Instant. No real client is named Phileas Fogg.

**Downsides.** The period register fights the product's vocabulary. A UI that
says "push notification", "composer", and "$0.14 this run" sitting above an 1872
steamer ledger reads as a costume, not a world. Currency fixtures in pre-decimal
sterling are either wrong or distractingly correct. You end up writing
anachronisms and apologising for them in a README.

---

### 4.2 — "Baker Street": the consulting practice

**The world.** A two-person consulting practice above a Marylebone shop: one
consultant who takes cases from walk-in clients and police referrals, and one
partner who writes everything down. The knowledge base *is* the second partner.

**Worked examples**

- *People.* **Sherlock Holmes** — the consultant; billable, irregular, terse.
  **Dr. John Watson** — the chronicler; owner of the brain, author of every
  note. **Inspector Lestrade** — the client-side contact at a large institution
  who forwards work with no context.
- *Organizations.* **Scotland Yard** (referring institution); **the Diogenes
  Club** (venue, and the source of a standing no-contact rule that makes a
  perfect calendar-conflict fixture).
- *Places (real coordinates).* 221b Baker Street — `51.5237, -0.1585`
  ([Wikipedia](https://en.wikipedia.org/wiki/Sherlock_Holmes_Museum)).
  Criterion, Piccadilly — `51.5098, -0.1341`
  ([Wikipedia](https://en.wikipedia.org/wiki/Criterion_Theatre)).
- *Project with a deadline.* **The Baskerville survey** — field report due
  1889-10-14, client travelling from 10-10, so the window is four days.
- *File paths.* `clients/baskerville/brief.md`,
  `cases/1889-10-03-dartmoor.md`, `talks/royal-institution.md`
- *Quotable sentence.* "The client says the hound was seen at nine; the
  stationmaster's log has the last train at eight-forty."
- *Invoice.* INV-0142 — Baskerville estate — £120 retainer plus 3 days at
  £15/day = £165, issued 1889-10-15, due 1889-11-01, unpaid 22 days.
- *Agent-run failure.* `note-filer` failed — `two documents claim the path
  cases/1889-10-03-dartmoor.md; refusing to merge. Dead-lettered after 3
  attempts.`

**IP and trademark.** Copyright is **clean in both jurisdictions today**: US
public domain since 2023-01-01, UK/EU since 2001-01-01 (see principle (b)). The
Seventh Circuit rejected the estate's theory that a "complex character" stays
protected until the last story expires
([Klinger v. Conan Doyle Estate, 7th Cir. 2014](https://fairuse.stanford.edu/case/klinger-v-conan-doyle-estate-ltd/)).

The overhang is behavioural, and it is documented. As of today the estate's own
licensing page still claims it *"owns the last remaining protected story and
character copyrights in the USA"* — a claim that has not been true since
2023 — and separately asserts *"trademark and common law rights in the name and
image of Sir Arthur Conan Doyle, Sherlock Holmes, Professor Challenger"* in the
**USA, European Union, UK and many other countries**
([Conan Doyle Estate](https://conandoyleestate.com/licensing/trademarks-and-copyrights)).
The estate has litigated repeatedly, including against a later film
([Copyright Lately](https://copyrightlately.com/enola-holmes-copyright-infringement-case/)).

Under principle (c) a fixture row is not trademark use, and under (b) there is
no copyright left to infringe. Under principle (d), none of that stops a letter.

**Risk: MEDIUM.** Low on the merits, medium in practice, entirely because of
the counterparty's documented posture. Mitigable by using only Watson, Lestrade
and Mrs Hudson and *not* the two names the estate specifically enumerates — but
a Holmes world without Holmes is not worth the trouble.

**Fit.** The best of the six, by a distance. A consulting detective is
literally a consultant: cases are projects, retainers and day rates are
invoices, referrals are a client pipeline, London addresses are real
coordinates, and the entire premise is one person maintaining a written archive
of another person's work. Every dimension in §1 lands without forcing.

**Recognisability.** Instant, and pleasurable.

**Downsides.** The estate. Beyond that: Holmes is the single most over-used
world in sample data, so it carries no novelty; and casting a famous villain as
the untrusted origin is more cute than clarifying.

---

### 4.3 — "The Documented Companies": the fake-corporate conventions

**The world.** The established placeholder corporations of software and screen
— Contoso, Fabrikam, ACME, Initech, Vandelay, Cyberdyne — assembled into the
client list of an otherwise generic consultancy.

**Worked examples**

- *People.* None supplied by the source material. These are company names, not
  casts; every person, quote and conversation would still have to be invented.
  That is the structural problem with this option, stated first because it
  decides the rest.
- *Organizations.* **Contoso Ltd.** (the canonical multinational, documented by
  Microsoft as headquartered in Paris); **Fabrikam, Inc.** (the finance and ERP
  sample company).
- *Places (real coordinates).* Contoso's canonical Paris HQ and a second
  office — both would need real coordinates assigned by us, because the source
  material supplies none.
- *Project with a deadline.* Invented.
- *File paths.* `clients/contoso/retainer-2026.md` — and note that this path
  string, shipped in an npm package, is the use the trademark below covers.
- *Quotable sentence.* Invented.
- *Invoice.* Invented.
- *Agent-run failure.* Invented.

**IP and trademark. This is the section that eliminates the option.**

- **CONTOSO is a live registered United States trademark owned by Microsoft
  Corporation** — Reg. No. **6728689**, Ser. No. 90700798, registered
  **2022-05-24** — and the registered services are *"providing educational
  information on-line in the nature of providing online, non-downloadable
  simulated case studies"* and *"training using simulated case studies of
  business environments"*
  ([USPTO record](https://uspto.report/TM/90700798),
  [USPTO notice of registration](https://tmng-al.uspto.gov/resting2/api/casedoc/cms/case/90700798/notice/90700798_6728689_20220524_ext.pdf)).
  There is a parallel UK registration, UK00003639796
  ([Trademarkia](https://www.trademarkia.com/contoso-UK00003639796)). **Our
  intended use is simulated case studies.** This is not an adjacent class; it is
  the registered class.
- Microsoft's own account is explicit that this was never a public dedication:
  *"The Trademark Group performed background checks on these names and cleared
  them for use as fictitious entities **by Microsoft samples and
  documentation**"*
  ([The Old New Thing](https://devblogs.microsoft.com/oldnewthing/20061013-05/?p=29393)).
  Clearance for Microsoft is not a licence to us. Microsoft began replacing
  Contoso and Fabrikam with a new sample brand in late 2025
  ([The Register](https://www.theregister.com/offbeat/2025/12/01/microsoft_replaces_loyal_customers_contoso_and_fabrikam/2808360)),
  which is how an owner treats a brand asset, not a commons.
- **ACME**: Warner Bros. holds trademark rights in the Looney Tunes usage
  ([Warner Bros. wiki](https://warnerbros.fandom.com/wiki/ACME_Corporation)),
  and separately a large number of unrelated real companies trade as Acme.
- **Cyberdyne**: **Cyberdyne Inc.** is a real, publicly-traded Japanese robotics
  company founded 2004, using the name in commerce for exoskeletons
  ([Wikipedia](https://en.wikipedia.org/wiki/Cyberdyne_Inc.)). A software
  fixture naming "Cyberdyne" as a client is naming a real firm.
- **Dunder Mifflin**: actively litigated — NBCUniversal sued over the mark in
  2022 after its own application was refused
  ([Deadline](https://deadline.com/2022/07/the-office-lawsuit-dunder-mifflin-trademark-infringement-lawsuit-nbcuniversal-1235058437/),
  [World Trademark Review](https://www.worldtrademarkreview.com/article/the-battle-dunder-mifflin-the-global-effort-trademark-fictional-paper-company)).
- **Vandelay**: a VANDELAY registration (Ser. 74729585) was cancelled in 2003
  ([Furm](https://furm.com/trademarks/vandelay-74729585)); the underlying
  series rights sit with a studio.
- **Initech**: film-derived, studio-owned by association.

**Risk: MEDIUM–HIGH, and the highest of the six.** This is the counterintuitive
result and it is worth stating plainly: *the two Victorian novels are safer than
the "safe" corporate placeholders.* The novels' rights-holders are estates
asserting marks outside our class; Contoso's rights-holder is Microsoft, with a
live registration squarely inside it.

**Fit.** Half a world at best. It supplies a client list and nothing else — no
people, no places, no documents, no quotes, no failures.

**Recognisability.** High among developers who know the conventions, near zero
outside them. A non-developer reviewing a public Storybook would read "Contoso
Ltd." as a real company, which is the opposite of what we want.

**Downsides.** Highest legal risk, lowest content yield, and the one option
whose risk is concentrated in exactly our use case.

---

### 4.4 — "Cedar Hollow, extended": grow the world the repo already has

**The world.** The existing fixture persona — a park ranger at a mid-sized
wilderness preserve, tracking health, woodworking and evening astronomy — grown
sideways to cover the dimensions the kit needs: a district contracts officer, a
timber vendor, permit deadlines, visitor-centre talks, and a seasonal budget.
All surnames become `Example`, which turns the repo's existing one-name rule
into a systematic tell.

**Worked examples**

- *People.* **Alex Example** — ranger; owner of the brain (unchanged, already
  in `packages/core/fixtures/corpus/me/identity.md`). **Bo Example** —
  volunteer coordinator; the person Alex owes three replies. **Dana Example** —
  district contracts officer; the counterparty on every invoice and the source
  of every hard deadline.
- *Organizations.* **Cedar Hollow Wilderness Preserve** (the employer);
  **Ridgeline Timber & Signage** (the vendor on the trail-signage project, which
  already exists in the corpus at `projects/active/trail-signage/`).
- *Places (real coordinates).* The preserve is fictional, so its coordinates
  must be **assigned to real, public, non-residential landmarks** and that rule
  written into the fixture README. Verified examples to draw from: Goldstone
  Deep Space Communications Complex — `35.4267, -116.8900`
  ([Wikipedia](https://en.wikipedia.org/wiki/Goldstone_Deep_Space_Communications_Complex))
  as the dark-sky observing site that ties to the corpus's astronomy thread; and
  Amundsen–Scott South Pole Station — `-90.0000, 0.0000`
  ([Wikipedia](https://en.wikipedia.org/wiki/Amundsen%E2%80%93Scott_South_Pole_Station)),
  which is a real place *and* the edge case that exercises `MapView`'s ±85°
  Mercator clamp.
- *Project with a deadline.* **Trail signage, phase 2** — 14 routed cedar
  blanks installed before the seasonal closure on 2026-11-01; the county permit
  expires 2026-10-24, so the real deadline is eight days earlier than the
  obvious one.
- *File paths.* `projects/active/trail-signage/materials.md` (exists today),
  `contracts/ridgeline/po-0142.md`, `talks/visitor-centre-dark-sky.md`
- *Quotable sentence.* "Dana approved fourteen blanks, not twenty — the permit
  is written per-sign, and the note that says twenty predates the permit."
- *Invoice.* PO-0142 — Ridgeline Timber & Signage — 14 cedar blanks at
  USD 38.00 = USD 532.00, issued 2026-06-20, net 30, due 2026-07-20, **11 days
  overdue against the corpus reference date of 2026-07-12**.
- *Agent-run failure.* `source-watch` failed —
  `WebFetch https://permits.example.gov/ch-2026 — DNS NXDOMAIN. 1 action
  blocked, premise "permit expires 2026-10-24" now unverified (24d old).`

**IP and trademark.** **No source material at all.** Nothing is derived from
any copyrighted work, so there is no term to check in any jurisdiction and no
character name to clear. The only residual exposure is accidental collision
between a coined organization name and a live mark — handled by a one-time
clearance search, exactly as Microsoft's trademark group did for its own set.

**Risk: LOW.** The lowest of the six alongside §4.5.

**Fit.** Better than it sounds. The knowledge-worker frame the kit needs —
clients, invoices, deadlines, talks, venues — maps onto public-land work without
strain: a contracts officer is a client, a purchase order is an invoice, a
permit is a hard deadline, a visitor-centre evening is a talk, a trailhead is a
venue. And it preserves the corpus README's deliberate choice to keep the
persona **outside** the maintainer's real professional shape, which the design
drop's consultant framing quietly abandons.

**Recognisability.** Very high, and it improves on what exists: a cast where
every surname is `Example` cannot be mistaken for real data even at a glance,
and a grep for a surname that is not `Example` becomes a usable leak detector.

**Downsides.** Not a pop-culture world, which is what was asked for — it has no
inherited charm and no shared reference. It is also the most *writing* of the
six: the existing 33 files cover documents well and cover people, money, places
and agent runs not at all, so roughly two-thirds of the world still has to be
authored. A cast of Examples is deliberately flavourless, and flavourless mock
data makes Storybook stories harder to tell apart.

---

### 4.5 — "The Reserved World": build the universe out of the standards

**The world.** Every identifier in the fixture set is drawn from a range some
standards body has formally reserved for documentation. People share the
surname `Example`, hosts are `example.com`, addresses are TEST-NET, phones are
the 555-01xx block, and the one place on the map is the coordinate that GIS
systems use to trap bad data.

**Worked examples**

- *People.* **Alex Example**, **Bo Example**, **Cass Example** — roles assigned
  per story, surname invariant.
- *Organizations.* **Example Corp** (`example.com`); **Test Labs**
  (`labs.example`).
- *Places (real coordinates).* **Null Island** — `0.0000, 0.0000`. Not a
  landmass, but a real location with a real history: an ATLAS weather buoy sat
  there from 1997 until decommissioning in March 2021, and mapping systems use
  the coordinate deliberately *"to trap errors"* — bad records cluster there
  rather than scattering across the map
  ([Wikipedia](https://en.wikipedia.org/wiki/Null_Island)). Using it as the
  "coordinate not yet known" fixture is semantically correct, not a joke.
  Second place: Amundsen–Scott South Pole Station — `-90.0000, 0.0000`, the
  Mercator-clamp edge case.
- *Project with a deadline.* **Example Corp migration** — cutover 2026-10-15,
  freeze from 2026-10-08.
- *File paths.* `clients/example-corp/brief.md`,
  `talks/2026-09-example-conf.md`, `notes/2026-09-15-bo.md`
- *Quotable sentence.* "Bo said the freeze starts on the eighth; the contract
  says the fifteenth, and the contract is the one Example Corp will read."
- *Invoice.* INV-0100 — Example Corp — EUR 1,000.00, issued 2026-09-15, net 30,
  due 2026-10-15. Bank details shown masked as `IBAN ····0100` and never in
  full (see §6 — there is no reserved IBAN range).
- *Agent-run failure.* `source-watch` failed —
  `WebFetch https://feeds.example.com/weekly — NXDOMAIN.` This failure is
  **genuinely reproducible offline**, because the reserved domain really does
  not resolve. No other proposal can say that.

**IP and trademark.** Nil. Every value is drawn from a published reservation
whose stated purpose is documentation.

**Risk: LOW — the floor.** There is no lower-risk option available.

**Fit.** Neutral by construction: the frame is whatever we write, so it fits
anything and suggests nothing.

**Recognisability.** Maximum. Impossible to mistake for real data.

**Downsides.** No texture at all. Three people named Example are hard to tell
apart in a component gallery, which undercuts the whole point of `ContactCard`,
`GraphView`'s person/company/project legend, and any story about relationships.
A design system's Storybook is a sales surface as much as a test surface, and
this world makes it read as unfinished. It is the correct **substrate** and a
poor **world** — which is why §6 promotes its identifier rules to universal and
§7 does not recommend it as the world.

---

### 4.6 — Wildcard: "The Relay Practice"

**The world.** A two-person consultancy in a domain that cannot exist: they
design time-zone and calendar systems for off-world settlements, billing Earth
agencies by the day from real ground-station sites. The subject matter is
impossible; the business shape — clients, retainers, talks, deadlines,
overdue invoices — is exactly the one the kit needs.

**Worked examples**

- *People.* **Ines Marchetti** — principal; writes the standards documents.
  **Otto Lindqvist** — operations; runs the agent, owns the ledger.
  **Priya Raghavan** — liaison at the client agency; the source of every
  deadline change and of the calendar conflict fixture.
- *Organizations.* **Meridian Relay Group** (the practice); **Cebreros Ground
  Segment** (the client agency, named for its real site).
- *Places (real coordinates).* Cebreros Station, Spain — `40.4528, -4.3676`
  ([Wikipedia](https://en.wikipedia.org/wiki/Cebreros_Station)). Goldstone Deep
  Space Communications Complex, California — `35.4267, -116.8900`
  ([Wikipedia](https://en.wikipedia.org/wiki/Goldstone_Deep_Space_Communications_Complex)).
  Both are real, public, government-operated, non-residential sites — the
  safest class of coordinate to ship.
- *Project with a deadline.* **Relay handover spec v3** — delivered to the
  client agency by 2026-10-02; the review window closes 2026-09-28, so the
  usable deadline is four days earlier.
- *File paths.* `clients/cebreros/handover-spec-v3.md`,
  `notes/2026-09-11-priya.md`, `talks/2026-10-lisbon-relay.md`
- *Quotable sentence.* "Priya asked for one clock per station; the spec we
  already sent assumes one clock per hemisphere, and nobody has reconciled
  those."
- *Invoice.* INV-0117 — Cebreros Ground Segment — 6 days at EUR 950/day =
  EUR 5,700.00, issued 2026-08-28, net 30, due 2026-09-27, **outstanding**.
- *Agent-run failure.* `researcher` failed —
  `WebFetch https://spec.example.org/relay/v2 returned 403 after 3 retries.
  Dead-lettered; 2 queue items blocked on this fetch.`

**IP and trademark.** **No source material.** Names are coined; the only
clearance needed is a search against live marks for the two organization names,
which is cheap and one-time. Real ground-station names are factual geographic
references, not marks used to identify our goods.

**Risk: LOW.**

**Fit.** Excellent — as good as §4.2 without the estate. Retainers, day rates,
overdue invoices, a talk circuit, venue coordinates, spec documents with
diffable frontmatter, and a client liaison who changes her mind on a schedule.
Every dimension in §1 is native.

**Recognisability.** High, but achieved by subject matter rather than by
naming: nobody's real client is an off-world settlement standards body. This is
weaker than the `Example` surname tell, because the *people's names* look
entirely plausible. Mitigate by keeping every hostname on `example.com` and
every phone in the 555-01xx block, so the machine-readable fields stay obviously
fake even where the human-readable ones do not.

**Downsides.** Two. First, it has no shared cultural reference, so it carries no
charm and no memorability — a reader has to learn it. Second, and more
seriously, plausible-looking person names are exactly what we are trying to make
impossible: "Ines Marchetti" could be someone's real client contact, and a
reviewer skimming a diff cannot tell at a glance. This is the same defect that
let `Nordwind` into the tree.

---

## 5. Replace the persona, or layer a world around them?

The corpus persona is load-bearing, so this is a separate decision from choosing
a world — and the cheaper answer is not the one the file count suggests.

### What the persona actually costs to rename

Measured, not estimated. The full name appears in **30 files**; the bare given
name adds **3 more** (two in `packages/ui-react/tests/`, one in
`packages/ui-server/tests/app-wiring.test.ts`), for **33 touched files**.

| Group | Count | Cost to rename |
|---|---|---|
| Corpus prose (`me/identity.md`, `me/basics/*`, `_index.md`, `brain.config.ts`) | 6 | Real editing — the name is woven into sentences, not sitting in a field. |
| Test files | 13 | **Cheap.** Nearly every use is a self-contained literal in the test itself — an RSS `<dc:creator>`, an `x-forwarded-user` header, a `{ name, role }` object — not an assertion about corpus content. Mechanical find-and-replace. |
| Docs (`AGENTS.md`, `CONTRIBUTING.md`, `docs/configuration.md`, two plan docs, two package READMEs) | 7 | Mechanical. |
| `studies/star-chart.pdf` | 1 | Binary; embeds the name. Must be regenerated — but the fixtures README documents it as a minimal deterministic 1-page PDF with regeneration scripts, so this is minutes, not hours. |
| `brain.db`, `-wal`, `-shm` | 0 | **Not tracked.** `git ls-files` returns 29 source files and no database. Regenerating the index is free, exactly as the "markdown is the source of truth" rule promises. |

So a wholesale rename is **moderately cheap** — a day's careful work, no golden
files on disk, no committed database, no snapshot fixtures anywhere in the repo.

### What is actually expensive is *adding* to the corpus

This is the finding that decides the question. `packages/core/fixtures/README.md`
documents the corpus as a precision instrument with **global invariants**, not a
bag of sample documents:

- *"The only unresolved links in the whole corpus are the two intentional
  `[[does-not-exist]]` references."*
- *"Every non-exempt content file has at least one resolved in- or out-link
  except `notes/loose-idea.md`"* — which is the designated orphan, and the
  orphan test depends on it being the only one.
- Basename ambiguity is **engineered**: two `overview.md` files exist so that a
  bare `[[overview]]` resolves to the sibling, and the two `status.md` files are
  deliberately never bare-linked.
- Every staleness and index-lag window is computed against a pinned reference
  date, with a documented scenario-to-fixture table asserting specific day
  counts.

Adding the fifteen-or-so documents a full world needs — people, organizations,
invoices, venues, calendar entries, agent runs — would create new orphans, new
unresolved links, new ambiguous basenames and new staleness candidates. **Every
one of those is an existing assertion.** The churn risk is real, but it comes
from *additions*, not from the rename.

### Per-proposal: replace or layer?

| Proposal | Implies | Touched test files | Why |
|---|---|---|---|
| 4.1 Eighty Days | **Replace** | 13 + PDF | A park ranger cannot own an 1872 circumnavigation ledger. The `me` persona must become a period character, and every date in the corpus (pinned to 2026) becomes incoherent — this is the hidden cost: it is not a rename, it is re-dating the entire fixture set. |
| 4.2 Baker Street | **Replace** | 13 + PDF | Same problem. The brain's owner has to be the chronicler, and the corpus's 2026 dates have to move to 1889 or the world has to accept an anachronism it cannot explain. |
| 4.3 Documented Companies | **Layer** | 0 | Supplies only organizations, so it layers by construction — which is the one thing in its favour. |
| 4.4 Cedar Hollow extended | **Layer** — the persona *is* the corpus owner already | **0** | Nothing to rename. The world grows outward: a contracts officer, a vendor, permits, talks. |
| 4.5 Reserved World | **Layer** | 0 | The persona is already an `Example`; the convention extends to everyone else. |
| 4.6 Relay Practice | **Layer, with friction** | 0–13 | The persona can stay the brain's owner only if a park ranger plausibly consults on off-world clock design, which he does not. Either accept an unexplained persona, or replace. |

**Recommendation on this axis: layer, and keep the persona.** Keep the existing
persona as the corpus owner — the `me` whose brain this is — and let the chosen
world supply everything *around* them: clients, colleagues, vendors, venues,
correspondents, projects and money. That is free (zero touched test files),
preserves the documented scenario contract, and keeps the corpus's deliberate
choice to sit outside the maintainer's real professional domain.

It also quietly eliminates 4.1 and 4.2 on cost grounds that have nothing to do
with their IP position: **both require re-dating the entire fixture corpus**,
because a pinned 2026 reference date is load-bearing for every staleness
assertion and neither Victorian world can host it.

### Where should the new world live?

**Under `packages/ui-kit/`, not in `packages/core/fixtures/corpus/`.**

- The corpus is a **search-and-indexing** fixture with per-file assigned roles
  and global link/orphan invariants. Its job is to make FTS, wiki-link
  resolution, staleness and classification assertions deterministic. Adding
  people-and-invoices documents to it puts presentation data into a search
  fixture and risks four test files (`packages/core/tests/cli-harness.ts`,
  `packages/ui-server/tests/integration/brain-db-schema-contract.test.ts`,
  `tests/brain-db-contract.test.ts`, `tests/changeset-gate.test.ts`) plus the
  scenario contract for no benefit.
- The kit's needs are **typed view-model objects**, not markdown on disk. A
  `ContactCard` wants a person record; a `BarList` wants rows with units; a
  `MapView` wants a lat/lon pair. None of that should round-trip through an
  indexer to reach a story.
- Storybook must stay self-contained. A ui-kit story reaching across the
  workspace into core's fixtures couples a design-system package to a search
  fixture's invariants, and the deployed Storybook would carry them.

Concretely: `packages/ui-kit/fixtures/` exporting typed collections
(`people`, `orgs`, `places`, `projects`, `invoices`, `runs`, `documents`), with
the persona re-exported as the single shared point of contact between the two
fixture sets, so the kit and the corpus tell the same story without sharing a
substrate.

If some core test later genuinely needs a person or an invoice *document*, add
it to the corpus deliberately, as a scenario row in the fixtures README with its
link and orphan status decided — never as a side effect of building a story.

---

## 6. Reserved standards to adopt regardless of which world wins

These are orthogonal to the choice of world. Every one of them should be written
into `AGENTS.md` and, where mechanically checkable, into the lint gate. This
list is the part of the document with the longest shelf life.

| Domain | Reserved value | Authority |
|---|---|---|
| Domain names | `example.com`, `example.net`, `example.org` | [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606.txt) |
| TLDs | `.test`, `.example`, `.invalid`, `.localhost` | [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606.txt) |
| Email | any local part `@example.com` | RFC 2606, by construction |
| IPv4 | `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` | [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737.txt) |
| IPv6 | `2001:db8::/32` | [RFC 3849](https://www.rfc-editor.org/rfc/rfc3849.html) |
| AS numbers | `64496`–`64511`, `65536`–`65551` | [RFC 5398](https://datatracker.ietf.org/doc/html/rfc5398) |
| MAC (EUI-48) | `00-00-5E-00-53-00` … `00-00-5E-00-53-FF` unicast; `01-00-5E-90-10-00` … `-FF` multicast | [RFC 7042](https://www.rfc-editor.org/rfc/rfc7042.html) |
| Phone (US/CA/MX) | `555-0100` … `555-0199`, any area code | NANP, reserved for entertainment/advertising ([summary](https://en.wikipedia.org/wiki/555_(telephone_number))) |
| Phone (UK mobile) | `07700 900000` … `07700 900999` | Ofcom drama numbers |
| Phone (UK geographic) | `01632 960000` … `01632 960999`; `020 7946 0xxx` (London) | Ofcom — `01632` is a wholly reserved area code |
| US SSN | `987-65-4320` … `987-65-4329` | SSA advertising block; also never-issued areas `000`, `666`, `900`–`999` ([SSN-Check](https://www.ssn-check.org/facts)) |
| Payment cards | issuer test PANs only (e.g. Stripe `4242 4242 4242 4242`, Amex `3782 822463 10005`) — and prefer shipping a masked tail (`···· 4242`) over a full PAN ([list](https://ddbeck.com/fictitious-numbers/)) |
| Coordinates | `0.0000, 0.0000` (Null Island) as the "unknown/unset" sentinel; real **public, non-residential** landmarks otherwise; `-90.0000, 0.0000` as the Mercator-clamp edge case |

**Three things that are NOT reserved, and must be handled by policy instead:**

1. **IBAN — there is no reserved range.** ISO 13616 designates a registration
   authority for national formats but reserves nothing for testing. Every
   mod-97-valid IBAN a generator produces *could* correspond to a live account
   ([discussion](https://ibangenerator.wiki/)). **Policy: never ship a full
   IBAN in this repo.** Show a masked tail, or deliberately break the check
   digits so the value fails validation by construction.
2. **ISBN — no reserved range exists.** Use an obviously structural placeholder
   and never a Luhn/ISBN-valid string that could resolve to a real title.
3. **Company names — nothing is reserved, and the well-known placeholders are
   owned** (see §4.3). Any coined organization name needs a one-time clearance
   search before it lands.

**Two repo-specific rules that belong in the same list:**

4. **Dates are pinned, never wall-clock.** The corpus already fixes a reference
   date (`packages/core/fixtures/corpus/`, README). The kit's fixtures must use
   the same one, or staleness and index-lag stories drift into nonsense.
5. **Run `bun scripts/check-leakage.ts` against any proposed cast before
   adopting it.** The gate's denylist includes personal names that a plausible
   fictional cast could collide with by accident.

---

## 7. Recommendation

**Adopt §4.4 — "Cedar Hollow, extended" — as the fixture universe, and adopt
§6's reserved-identifier rules universally and immediately.**

The reasoning, in order of weight:

1. **It is the only option that does not fight a decision the repo already
   made.** `packages/core/fixtures/corpus/README.md` states that the persona is
   deliberately not a software-and-speaking persona *"so tests don't
   accidentally encode the maintainer's real domains."* The design drop's mock
   data — clients, a day rate, invoices, a talk circuit, conference venues — is
   precisely that shape. Importing any *new* consultant world, including the two
   good ones (§4.2, §4.6), re-creates the problem the corpus was built to avoid:
   fixture content that rhymes with the maintainer's actual working life is
   content where a real leak would look normal. Choosing a world that is
   structurally unlike the maintainer's work is a *security* property, not an
   aesthetic one.

2. **The `Example` surname convention is a better leak detector than any
   amount of charm.** The brief says recognisability is a feature because it
   makes real data leaking in obvious. A cast where every surname is `Example`
   converts that from a judgment call into a grep: any person-shaped string
   whose surname is not `Example` is a finding. None of the pop-culture worlds
   can offer that, and §4.6's plausible names actively defeat it.

3. **Risk is genuinely low and needs no annual re-check.** No source work means
   no term to track on Public Domain Day, no estate, no jurisdiction split. §4.1
   is nearly as safe but its term analysis is only stable because the author has
   been dead for 121 years; §4.2's is stable too, but its counterparty is not.

4. **Two-thirds of the writing is the same either way.** The corpus covers
   documents well and covers people, organizations, places, money, calendar and
   agent runs not at all. Every proposal here requires authoring those from
   scratch. Extending Cedar Hollow means the third that *is* done — 33 files of
   frontmatter, wiki-links, a dangling `[[does-not-exist]]` link, staleness
   pinned to a fixed date — carries forward instead of being thrown away and
   re-derived.

5. **It is free on the persona axis, and the two best pop-culture worlds are
   not.** Per §5, keeping the existing persona as the corpus owner touches
   **zero** test files. §4.1 and §4.2 both require *replacing* the persona —
   and, far more expensively, **re-dating the entire fixture corpus**, because a
   pinned 2026 reference date is load-bearing for every staleness, index-lag and
   propagation assertion, and neither a Victorian nor an 1872 world can host it.
   That cost was invisible until the corpus was measured, and it is larger than
   either world's IP risk.

6. **Its exposure to the leakage gate, while real, is fully controllable.**
   See the caveat below — this is the one reason that argues *against* the
   recommendation, and it is stated as such.

**The one serious objection, stated plainly: this world has the worst leakage-gate
exposure of the six.** Per §3, the persona runs seasonal wildlife surveys, and a
banned token is standard ornithological vocabulary — part of several official
species common names and routine in plumage description. A wildlife log is the
most natural way to grow this world and the most likely way to redden CI three
months from now. It does not change the recommendation, because the collision is
in optional descriptive prose rather than in anything the world requires, but it
converts one of §3's style rules into a hard, non-negotiable condition of
adoption:

> **Wildlife appears as plain sightings only — location, time, species common
> name — never with colour, plumage or morphology description.** Write this into
> `packages/core/fixtures/README.md` next to the scenario contract, not only
> into a planning document, because that README is what the next author reads.

The honest cost: **this is not the pop-culture answer that was asked for.** It
has no inherited world, no shared reference, and a deliberately flavourless
cast. It buys safety and leak-detectability with charm. That is the trade, and
it should be made knowingly.

Two mitigations make the trade cheaper. Put the *texture* in the situations
rather than the names — an overdue purchase order, a permit that expires eight
days before the obvious deadline, a note that contradicts a contract — since
those are what the components actually render. And keep every machine-readable
field (`hosts`, `IPs`, `phones`, `emails`) on the §6 reserved ranges, so even a
well-written fixture stays unmistakably synthetic in the fields a scanner reads.

### Runners-up

**§4.6 "The Relay Practice"** — *the right call if the Storybook is a public
sales surface first and a test substrate second.* It has the best fit of any
zero-IP option: retainers, day rates, overdue invoices, spec diffs, real
ground-station coordinates, and a liaison who changes the deadline. Choose it
if the maintainer decides a design-system gallery full of `Example` surnames
reads as unfinished to prospective users, and is willing to accept that
plausible person names cost the grep-level leak detection in reason 2. Adopting
§6's identifier rules on top recovers most of that loss for the
machine-readable fields. Two findings moved it closer to the recommendation:
it also layers for free on the persona axis (§5), and its gate exposure is
lower than the recommended world's, since a coined name pool is filterable by
construction while a nature persona's descriptive vocabulary is not.

**§4.2 "Baker Street"** — *the right call if the estate risk is retired.* On
fit it beats everything: a consulting detective with cases, retainers,
referrals, real London coordinates and a partner whose entire job is keeping the
archive. Its copyright position is clean in both jurisdictions today. Choose it
if either (a) the maintainer is comfortable that a fixture row is not trademark
use and is willing to absorb a letter, or (b) a cheap clearance opinion confirms
it — and note the cast can be built from Watson, Lestrade and Mrs Hudson, none
of whom the estate enumerates in its trademark claim, if a hedged version is
wanted. **It dropped from first to third runner-up on measurement, not on
law.** Retiring the estate risk is now the *smaller* of its two costs: per §5 it
also forces a persona replacement and a re-dating of the whole corpus, because
every staleness assertion is pinned to 2026 and an 1889 practice cannot host
that date. Budget that before budgeting the clearance opinion.

**Not recommended: §4.3.** The "obviously safe" corporate placeholders are the
riskiest option on the table. `CONTOSO` is a live Microsoft registration whose
recited services are *simulated case studies* — our exact use — and the rest of
the set is owned by studios or, in Cyberdyne's case, by a real operating
company. It also supplies the least content per unit of risk: a client list, and
nothing else.
