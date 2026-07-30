# Name Research — replacing "brainform"

Date: 2026-07-17/18 · Status: **decision open** — vetted shortlist ready, recommendation below.
Companion to [07-oss-readiness-review.md](07-oss-readiness-review.md) §6, which holds the
condensed version. This document is the full record: context, method, every direction explored,
raw check data, and the endoxa deep-dive.

---

## 1. Context: why a rename at all

The OSS-readiness review (2026-07-17) included a routine name-collision check before the public
launch of the brainform platform (npm scope `@brainform/*`, docs site, template repo). The check
came back negative on two hard assets and one brand risk:

1. **brainform.ai is an active commercial startup** — "The Company Brain for Agentic
   Interactions" / "AI for Agentic Commerce". It structures catalog data for **MCP and A2A
   protocols** and deploys "intelligent agents" from a "Knowledge Library". Not the same product
   (B2B commerce vs. personal knowledge base), but it shares the name, the brain/agent framing,
   and even MCP as a protocol. It looks funded and operational (SOC 2, enterprise deployments,
   LinkedIn presence). Real SEO/brand-confusion exposure and non-trivial trademark risk from an
   active business in an adjacent AI-agent niche.
2. **github.com/brainform is taken** — an org with no public repos, private membership,
   pointing at brainform.co (`support@brainform.co`). The canonical GitHub org name is gone.
3. Minor noise: an academic BCI game literally named "BrainForm" (arXiv paper,
   `BRomans/BrainForm`), several unrelated "Brainformer" ML-architecture repos.

For contrast, the npm side was technically open: the bare `brainform` package returned 404 and no
scope conflict surfaced. But a name where the .ai domain, the GitHub org, and the commercial
brand identity all belong to someone else in the same broad space is burned regardless of npm
availability. Decision: rename **while everything is still private** — the cheapest moment it
will ever be.

Also relevant: the `brain` **CLI command** has a soft collision — a dormant npm package
`brain-cli` (last published ~4 years ago) claims a `brain` bin. Low risk; a `command -v brain`
note in onboarding docs suffices. The CLI name, `brain.config.ts`, and `brain.db` are **not**
part of the rename — the platform name is scope + org + website only.

## 2. Rejected candidate: `ua-brain`

Proposed as "user-agent brain". Availability was clean (npm 404, GitHub user 404), but rejected
on three grounds:

1. **The `ua-` prefix is owned by User-Agent parsing.** `ua-parser-js` alone does ~116M
   downloads/month; effectively every `ua-*` package on npm is browser/device sniffing. The
   exact target audience (developers) will shelve `ua-brain` as a device-detection library.
2. **UA = Ukraine.** Strong association since 2022. Compounding: "Brain" is a large Ukrainian
   electronics retailer (brain.com.ua) — GitHub is already littered with `brain_ua_*` test
   projects targeting it, so "ua-brain" reads as a fan client for a Ukrainian electronics shop.
3. **The pun needs a footnote.** "User-agent working for the user" is clever once explained; a
   name that requires the explanation loses it. Pronunciation is also ambiguous
   (you-ay-brain? oo-ah-brain?).

## 3. Criteria

Distilled from the brainform and ua-brain failures:

- Single pronounceable, spellable word (it will be typed daily as `@scope/core`).
- The "brain" concept must survive the name (CLI stays `brain`; the story must connect).
- Clean npm bare name **and** scope, GitHub org (or acceptable variant), usable domain.
- No active company on the name in the AI/software space (the brainform failure mode).
- Doesn't pattern-match an existing package genre (the ua-brain failure mode).
- No unfortunate meanings in major languages; SEO not swamped by an unrelated dominant meaning.

## 4. Generation: concept families explored

Candidates were generated from concept families rather than free association, so each name comes
with a built-in story:

| Family | Idea | Candidates surfaced |
|---|---|---|
| Brain anatomy | infra/executive metaphors for "the system around your brain" | forebrain, brainstem, glia, myelin, hippocamp, neocortex, sulcus/gyrus |
| Neuroscience homage | founding figures | cajal (Ramón y Cajal), golgi, tulving, ebbinghaus |
| Memory-technology traditions | pre-digital personal knowledge systems — the strongest conceptual vein | **florilegium** (medieval excerpt anthology), **zibaldone** (Leopardi's "heap" notebook), **hypomnema** (Foucault's notes-as-technology-of-self), silva rerum (Polish family书 "forest of things" → sylva), commonplace, **quipu** (Incan knot records), **loci** (method of loci / memory palace), **kashkul** (dervish gathering-bowl → Persian miscellany genre), safina (Arabic notebook-anthology), vade mecum, syntopicon |
| Knowledge-keeper archetypes | the agent as keeper of your lore | skald, kvasir, edda, mimir, muninn/huginn, **ollam** (old-Irish master-scholar), famulus (scholar's assistant), seanchaí, amanuensis, bard |
| Greek philosophy | epistemic terms | **endoxa** (Aristotle: reputable opinions), noema/noesis, anamnesis (Plato: recollection), doxa, stoa, phronesis, hexis, metis |
| Garden / craft | digital-garden and weaving metaphors | hortus, trellis, espalier, topiary, weft, loom, orrery (working model of your world), granary, larder |
| Memory words, other languages | | minne (Norse/MHG: memory+love), kioku (JP), tansu (JP chest), smriti (Sanskrit: "that which is remembered"), kosha (Sanskrit thesaurus/treasury), gedanken, merken |
| brain-compounds | keep the family resemblance | brainstem, brainforge, brainloom, exobrain, exocortex, brainkit, openbrain, outbrain |

Names killed at the desk before any check (known collisions): codex (OpenAI), synapse (Matrix),
axon (Axon/Taser), cortex, cerebro, mnemosyne (spaced-repetition app), munin (monitoring),
huginn (automation project), mimir (Grafana), geist (Vercel font), noosphere (Subconscious
protocol — directly adjacent space), golem (crypto + golem.de), loom (Atlassian), warp
(warp.dev), atlas, gnosis (crypto), akasha (web3), marginalia (search engine), pensieve
(Rowling), noggin (Nick Jr.), vellum (vellum.ai), scrivener, quaderno (tax SaaS), tika (Apache),
outbrain (ad network), openbrain (AI-2027 fiction + taken), daftar (drowned in Indonesian
"daftar slot" spam SEO), braintrust (braintrust.dev).

## 5. Round 1 — availability batch check (34 candidates)

Method: npm registry probe (`GET registry.npmjs.org/<name>`, 404 = free), GitHub user/org probe
(`GET api.github.com/users/<name>`, 404 = free), npm similar-package search. 2026-07-17.

**Bare npm name free (8):** forebrain, kashkul, ollam, endoxa, zibaldone, florilegium, cajal,
hortus.

**npm taken (26):** brainstem, brainforge, exobrain, famulus, sylva, mneme, loci, orrery,
granary, minne, skald, kvasir, edda, awen, hypomnema, weft, glia, myelin, noema, scriptorium,
stoa, quipu, smriti, anamnesis, tansu, carnet.

**GitHub user/org free:** florilegium only. Every common single word is squatted as a GitHub
username — treated as a soft criterion (org variants or a squat-release request are normal), not
a hard filter.

Notable near-misses worth recording: *mneme* (the muse of memory — perfect fit, npm taken),
*loci* (method of loci — npm taken, defunct crypto), *orrery* (lovely metaphor, npm taken),
*minne* (memory+love double meaning, npm taken), *famulus* (exactly the agent role, npm taken).

## 6. Round 2 — web vetting of the 8 survivors

Each survivor checked for: active companies/products (esp. AI/software), prominent OSS,
trademark red flags, bad connotations across major languages, SEO viability.

| Name | Verdict | Evidence |
|---|---|---|
| **florilegium** | **CLEAN** | No competing software or AI product. The word lives in literary/botanical space (an academic journal, botanical-art anthologies, a story game) — thematically on-brand, not damaging. Minor GitHub noise (`abap-florilegium`). Only name with the GitHub user also free. Cost: 12 letters, first-time spelling. |
| **zibaldone** | **MINOR NOISE** | One dormant 3-star repo (`damko/zibaldone`, markdown-to-book tool, self-declared unstable), a Leopardi-studies platform (zibaldone.net), a niche card app. Literary pedigree is a feature. |
| **endoxa** | **MINOR NOISE** | Endoxa Corp (US federal contractor) and a South African retail-automation firm exist, neither developer-facing; dead `endoxa-graph` repo (2013). Shortest, easiest to type/say of the clean options. Full deep-dive in §8. |
| **kashkul** | **CLEAN-ish** | No competing software under this spelling. Concerns: transliteration variance (kashkul/kashkol/kaskul) hurts spelling + SEO; literal "begging bowl" is an odd brand note, though the "vessel that gathers your treasures" story is the best metaphor of the set. |
| forebrain | **RISKY** | Three live tech companies: Forebrain Technologies (US enterprise software/consulting; HP, Toyota, Disney, Broadcom as claimed clients — forebrain.net), foreBrain Innovation (India), Forebrain Neurotecnologia (Brazil neuromarketing, forebrain.com.br). Crowded. |
| cajal | **RISKY → near-DEAD** | Cajal Technologies: **trending YC W26 AI startup** (caj.al, "Provably correct code", Tau prover), ToS explicitly asserts "Cajal" as a trademark. Plus Cajal Neuroscience ($96M, Lux Capital) and the historic Cajal Institute (CSIC). In the news cycle, adjacent space. |
| hortus | **RISKY** | Saturated generic Latin: HORTUS Technology (landscaping SaaS), Hortus App, and **HortusFox** — a self-hosted, MIT, Docker-Compose OSS project (same deployment story, different domain). Developer-audience confusion likely. |
| ollam | **DEAD** | One-letter, same-pronunciation near-miss of **Ollama**, which owns the local-LLM category. Precedent proves the risk is enforced: Ollama-WebUI was pushed to rebrand to Open WebUI over exactly this proximity (ollama-webui discussion #602). |

**Researcher ranking of survivors:** 1. florilegium (most distinctive, truly uncontested),
2. zibaldone (punchier, needs a one-line explainer), 3. endoxa (best ergonomics, mild
namespace-sharing), 4. kashkul (best metaphor, worst spelling/SEO).

## 7. Recommendation

Two finalists, split by what you optimize for:

- **endoxa** — if typing ergonomics win. `@endoxa/core` is what gets typed daily; 6 letters,
  unambiguous pronunciation, techy sound. Aristotle's *endoxa* (Topics I.1): opinions held "by
  all, by the majority, or by the wise" — knowledge validated by accumulated trust, which is a
  fair description of a personal brain (and the repo literally has an `opinions/` directory).
- **florilegium** — if distinctiveness wins. "A gathering of flowers": the medieval anthology of
  excerpts, direct ancestor of the commonplace book — conceptually the *exact* product. Fully
  uncontested including the GitHub name. Cost: length and first-encounter spelling; memorable
  once learned.

Fallbacks: zibaldone, kashkul. Everything else: don't.

## 8. Endoxa deep-dive (triggered by ".com and .ai are registered — blocker?")

**Verdict: MANAGEABLE, leaning non-issue.**

### 8.1 Domain landscape (checked 2026-07-17, RDAP + DNS + HTTP)

Registered:

| Domain | State |
|---|---|
| endoxa.com | Registered since **1998**, hosted at Hetzner (`your-server.de`), registrant privacy-redacted. A thin WordPress site titled "Endoxa.com"; broken/mismatched TLS; stale content. Dormant legacy domain — no live business, no visible for-sale signal. |
| endoxa.ai | **Registered but fully dormant** — RDAP record exists (Identity Digital) but zero DNS. (Initial WHOIS suggested unregistered; RDAP is authoritative.) |
| endoxa.org | Redirects/pingbacks to **endoxalearning.com** (Endoxa Learning Ltd, below). |
| endoxa.net | Registered, nothing visible. |
| endoxa.io | IONOS default-site redirect — parked. |

**Available (all confirmed free via RDAP 404):** endoxa **.dev .app .sh .so .xyz .build .tools
.run .me .co .id .one .page .space .site .world .life .systems .software .digital .zone .cc
.ink**, plus `getendoxa.com` and `endoxahq.com`. The entire dev-native *and* general-audience
TLD family is open.

### 8.2 Who else uses the name

| Entity | What | Risk read |
|---|---|---|
| Endoxa Corp (Leesburg VA, founded 2015, `endoxa-us`) | Active US federal B2G contractor — data engineering/ML/distributed-systems consulting; SAM/DUNS/CAGE registrations, contract awards. | Services shop, no product, no located trademark. Distant market. |
| Endoxa Learning Ltd (UK, inc. 2018, Companies House 11393247) | Live K-12 EdTech SaaS — argument-visualization/critical-thinking platform. Closest real *software* use. | Asserts the **compound** mark "Endoxa Learning" in its legal notice; no confirmed registration of the bare word. UK-schools market, far from self-hosted dev tooling. |
| Endoxa (South Africa, endoxa.co.za) | Retail-automation / EDI B2B SaaS. | Distant market, no located filing. |
| Endoxa Solutions Ltd (Scotland, SC400595) | **Dissolved 2012.** | The name has recurring appeal, no sticky incumbent. |
| Endoxa Secure Solutions Ltd (15431272) | **Dissolved July 2025.** | Same. |
| Endox (endoxai.com, Boston) | Physical-AI/robotics defense startup. | Different name — not a collision, only SEO adjacency. |

### 8.3 Trademark

No bare "ENDOXA" wordmark covering software/SaaS (Nice classes 9/42) surfaced in Trademarkia or
WIPO-adjacent search; nearest hit was the unrelated medical mark ENDOAXIS. Caveat: the official
registries (tmsearch.uspto.gov, EUIPO TMview, UK IPO) blocked automated queries — **a 5-minute
manual pass on the official UIs is still pending** and should precede any own filing. Nothing
found suggests a blocker for mere use.

### 8.4 Does not owning .com/.ai matter? (precedents)

- **Astro** never owned astro.com — it belongs to Astrodienst, a thriving Swiss astrology
  business with overlapping semantic vibe. Zero documented friction at framework scale, through
  the Cloudflare acquisition (Jan 2026).
- **Bun** built its entire pre-1.0 adoption on bun.sh; bun.com came later.
- 2026 norm: vite.dev, biomejs.dev, astro.build — `.dev/.sh/.build` is the *expected* home for
  dev tooling; a bare .com can even read less credible to that audience.

Conclusion: the .com (dormant since 1998) and .ai (dormant, no DNS) are not blockers. The only
hard blocker class — a software-class trademark — has no positive evidence.

### 8.5 TLD choice (audience correction)

First suggestion was endoxa.dev; rejected because the product's audience is broader than
developers ("wrong audience"). General-audience sweep result and ranking:

1. **endoxa.app** — the product *is* an installable PWA; consumer-credible, Google TLD,
   HTTPS-enforced. **Primary pick.**
2. **endoxa.so** — the notion.so pattern; the de-facto personal-knowledge-product TLD.
3. endoxa.me — personal angle, slightly dated.
4. endoxa.one / endoxa.co — fine, generic.
5. Skip: .space/.world/.life/.zone (spam-tier), .id (Indonesia ccTLD registrar friction).

### 8.6 Handle status

- **npm**: bare `endoxa` package free; zero `@endoxa/*` packages; zero packages by any `endoxa`
  maintainer. Scope almost certainly free, but npmjs.com blocks anonymous scope checks
  (Cloudflare 403 on user/org pages; the couchdb-user endpoint now 401s) — **final confirmation
  = `npm org create endoxa` while logged in.**
- **GitHub**: `github.com/endoxa` is a **dead-squat Organization** — id 38348916, created
  2018-04-13T09:53:38Z, `updated_at` identical to `created_at` (never touched in 8 years),
  0 repos, 0 followers, no name/bio/blog. Worth one GitHub Support name-squatting release
  request (an empty org is the best possible case). Free fallbacks: `endoxa-hq`, `endoxahq`,
  `getendoxa`, `endoxa-app`, `endoxa-os`, `endoxa-project`.

## 9. Action checklist when the decision lands

If **endoxa**:

1. `npm org create endoxa` (definitive scope claim) + publish a placeholder under the scope.
2. Register **endoxa.app** + **endoxa.so** (+ optionally .me) the same day (~$60/yr).
3. File the GitHub Support squat-release request for `endoxa`; use `endoxa-hq` (or similar)
   until/unless it is granted.
4. Manual USPTO / EUIPO / UK-IPO word-mark pass (5 minutes each) before any own filing.
5. Rename repos/scopes per plan/07 sequencing (rename lands **before** the npm publish step).
6. Ignore endoxa.com/.ai — an opportunistic broker inquiry at most, never a launch gate.

If **florilegium**: same checklist; GitHub user `florilegium` is free, so no squat request; anchor
domain florilegium.app (availability re-check needed — not RDAP-swept in this round beyond the
name itself).

## Appendix A — raw round-1 check matrix

`npm` = registry HTTP status for bare package (404 = free). `gh` = api.github.com/users status
(404 = free). Checked 2026-07-17.

```
name          npm   gh     note
forebrain     404   200
brainstem     200   200    brainstem-redux et al.
brainforge    200   200
exobrain      200   200    also: ETRI "Exobrain" Korean gov AI project
famulus       200   200
kashkul       404   200
sylva         200   200
mneme         200   200
loci          200   200
orrery        200   200
granary       200   200
minne         200   200
skald         200   200
kvasir        200   200
edda          200   200
ollam         404   200    DEAD anyway (Ollama)
awen          200   200
endoxa        404   200    gh = empty org squatted 2018
zibaldone     404   200
florilegium   404   404    only fully-free name
hypomnema     200   200
weft          200   200
glia          200   200
myelin        200   200
cajal         404   200    DEAD anyway (Cajal Technologies, YC W26)
noema         200   200    also Noema Magazine
hortus        404   200
scriptorium   200   200
stoa          200   200
quipu         200   200    also Quipu invoicing SaaS (ES)
smriti        200   200    common given name
anamnesis     200   200    anamnesis-mcp exists
tansu         200   403*   rate-limited; npm taken (@amadeus-it-group/tansu)
carnet        200   403*   rate-limited; npm taken
```

## Appendix B — sources

- brainform burn: registry.npmjs.org/brainform (404) · github.com/brainform · brainform.ai
- ua-brain: registry search `ua-*` (ua-parser-js ~116M dl/mo) · github brain_ua_* repos
- Vetting: ycombinator.com/companies/cajal-technologies · caj.al · forebrain.net ·
  forebrain.com.br · github.com/danielbrendel/hortusfox-web · ollama.com ·
  github ollama-webui discussion #602 · en.wikipedia.org/wiki/Kashkul ·
  github.com/damko/zibaldone · linkedin.com/company/endoxa-us
- Endoxa deep-dive: RDAP via rdap.org (domain sweep) · who.is (endoxa.com 1998) ·
  endoxalearning.com · Companies House 11393247 / SC400595 / 15431272 · endoxa.co.za ·
  govcb.com SAM profile · astro.build vs astro.com (Astrodienst) · bun.sh history

---

# Part II — Exhaustive search (2026-07-18/19)

Context: endoxa judged "usable, not great." User asked for fresh directions, with
interest in **.ai** and **.me** TLDs. What followed was a very large fan-out —
**~165 names considered across 14 rounds**, each vetted for npm (bare + scope),
GitHub org, .ai/.me/.app/.com status, same-category / dev-tool / company collisions,
trademark/pharma, foreign-language meaning, SEO, and (crucially, since the product
is voice-first) pronounce/spell-from-hearing.

Two searches ran: an **evocative/real-word** search (Rounds 3–8) and, after the user
asked for "techy/modern/sophisticated" instead of "cutesy/literary," a
**techy** search (Rounds 9–14). Each produced a shortlist of 10.

## 10. The governing laws (what the whole search proved)

1. **The 2026 AI land-grab.** "Chat with your knowledge base / AI memory" is one of
   the most contested naming spaces in existence. Every name that *transparently*
   means memory/knowledge/mind/recall/scribe is already a funded AI startup or a
   prominent OSS memory-layer — often a near-clone of this exact pitch. Examples hit
   directly: Engram ($600M, Karpathy-backed), mnemo.ai, withlore.ai ("Cursor for your
   memory"), memra.ai ("sovereign agent + memory"), cognet.ai ("augmenting
   cognition"), mycelium.id, spandrel (markdown-KB-over-MCP), selvedge.sh
   ("long-term memory for AI codebases"), heddle.us ("weaving AI").
2. **Availability ∝ obliqueness.** The clearer a name says what the product *is*, the
   more certainly it's taken. Free names sit *outside* the semantic centre. This is
   why florilegium/endoxa survived Round 1, and why freshet/twitten/shieling survived
   here — off-centre metaphors nobody reached for.
3. **Glamour ↔ availability (techy register).** *Sophisticated* techy words are the
   single most fought-over namespace: they attract AI startups **and** dev-tools
   (engineers name projects after obscure technical terms) **and** premium domain
   investors, all at once (corpus.ai $1.3M, tenon.ai $39.9k, quiver.ai a16z-funded).
   The glamour that makes a word feel sophisticated is exactly what gets it claimed.
4. **Convergent coinage.** Even *invented* words get independently grabbed when they
   map to an obvious root — every mem-/cort-/cogn-/noe- coinage tried was already a
   live AI product (Memra, Cortiq, Retent, Mnesis, Cognet, Noeta). Only
   *semantically-opaque* coinages (Remnal, Drovon) stay free.
5. **Voice-homophone tax.** Voice-first means spell-from-hearing is a hard gate. It
   sank many otherwise-good names: shieling≈shielding, hummock≈hammock,
   moraine≈marine, whorl≈whirl, brume≈broom, pawl≈Paul, spinor≈spinner,
   Ytterbium/Rhenium/Fresnel/Knurl (silent/unguessable letters), cepstrum (hard/soft-C).
6. **Fast screens miss live products.** A "clean" npm+GitHub+.ai screen missed a live
   exact-name .com/.app product in ~40% of coinage cases (Servova, Klervo, Navrel,
   Norstra, Tenavo all had shipping namesakes). Confirmation vetting is mandatory.

## 11. Evocative / real-word search (Rounds 3–8)

Method per round: 10–12 candidates, one research agent each. Verdict scale:
CLEAN > MINOR NOISE (ship-able, one soft caveat) > RISKY > DEAD.

**Round 3 — memory-words (10):** engram, memex, mnemo, rune, mneme, lore, seshat,
nabu, loam, minne. All DEAD/RISKY (funded AI-memory startups + OSS memory-layers).

**Round 4 — coinages from memory roots (10):** amanu, scriv, anamne, memini, noesa,
scriva, camena, amne, recolla, reminia. All DEAD/RISKY (same-category AI products
pre-coined them; amanu.ai/scriv.ai/anamne.ai all live).

**Round 5 — keeper / archivist professions (12):** archivist, curator, registrar,
chronicler, seneschal, chatelaine, castellan, quaestor, factotum, bursar, sacristan,
tabellion. All RISKY (common-role words double-hit: dev-tool + same-category AI).

**Round 6 — arbitrary-evocative, the Obsidian/Roam pattern (12):** cairn, tarn, fen,
magpie, jackdaw, lodestar, sable, basalt, flint, heron, warren, marten. All DEAD/RISKY
— even arbitrary words are grabbed (cairn.ai, tarn.ai, sable = $45M Sequoia 2 days
prior, flintk12 YC Claude-powered).

**Round 7 — obscure-evocative (12):** rhizome, mycelium, coppice, tilth, tendril,
skein, oriel, spinney, caddis, gloaming, **inglenook**, **freshet**.
→ **freshet = MINOR NOISE** (first find: .ai+.me free, uncontested). inglenook RISKY
but .ai/.me likely free.

**Round 8 — obscure-evocative v2 (12):** selvage, heddle, runnel, espalier, umbel,
brume, pleach, reliquary, whorl, spate, corrie, swale. All DEAD/RISKY.

**Round 9 — odd/dialect: paths, deposits, shelters (12):** **twitten**, ginnel,
holloway, moraine, drumlin, **shieling**, tombolo, serein, fettle, pintle, cranny,
hummock.
→ **twitten** & **shieling = MINOR NOISE** (.ai+.me free). tombolo RISKY, domains free.

**Round 10 — shelter/path/deposit v2 (12):** bothy, **howff**, esker, bield, twitchel,
**snickelway**, holt, withy, catena, bothan, kame, ostracon.
→ **howff = MINOR NOISE**; **snickelway = MINOR NOISE** and *fully clean* (only name
whose bare GitHub org was also free). twitchel/bothan RISKY, domains free.

### Shortlist A — evocative (the "meaningful + free" set)

Winning recipe: odd/dialectal word · off-centre metaphor (a *route/shelter/gathering*,
not "memory") · no voice-homophone.

| Name | Story | .ai/.me | GitHub org | Cost |
|---|---|---|---|---|
| **freshet** | spring surge of fresh water = a flow of new ideas | free | suffix (freshethq) | "Fresh*" SaaS echo |
| **snickelway** | a hidden shortcut through a dense place | free | **free** | 10 letters; "snicker" echo |
| **twitten** | the little path you slip between ideas | free | suffix | "twit"/Twitter echo |
| **shieling** | the shelter you return to season after season | free | suffix | voice: "shielding" |
| **howff** | a favourite haunt/refuge you return to | free | suffix | voice: "huff"; hard to spell aloud |
| **tombolo** | a bridge that forms itself over time | free | suffix | menswear brand; "tombola" |
| **florilegium** | a gathering of excerpts (commonplace book) | recheck | **free** (username) | 12 letters |
| **inglenook** | the warm hearth-nook for your thoughts | likely free | variant | twee; .app taken |
| **endoxa** | knowledge held by the wise (Aristotle) | .app/.so free | dead-squat | "meh" per user |
| **twitchel** | a quiet way between (sibling of twitten) | free | variant | "twitchy" connotation |

Backups: minne, sacristan, bothan (each domains-free with a caveat).
Recommendation within A: **freshet** (all-rounder) · **snickelway** (only fully-clean
assets) · **florilegium** (on-theme classic).

## 12. Techy / modern / sophisticated search (Rounds 9–14 techy)

User feedback: the evocative set "sounds like a Harry Potter novel — too cutesy and
literary." Pivoted to a techy register (Vercel/Stripe/Modal). Result: real techy words
are essentially all taken (0 of ~85 cleared); only invented, semantically-opaque
coinages survive.

**Round 9 — techy real words (12):** corpus, lemma, lexeme, quiver, topos, apsis,
corundum, feldspar, vernier, chamfer, kerf, spandrel. 0 clean (AI startups + dev-tools
+ premium domains).

**Round 10 — machining / materials (12):** ferrite, ephemeris, collet, swarf, mandrel,
olivine, quiesce, spinor, knurl, cermet, gabbro, ferrule. 0 clean (engineers already
named projects after these: MandrelDB=GraalVM, ferrule=a language, etc.).

**Round 11 — physics-of-memory + mechanics (12):** hysteresis, remanence, etalon,
mortise, tenon, pawl, detent, fresnel, cepstrum, **gudgeon**, albedo, anneal.
→ **gudgeon = MINOR NOISE** (.ai/.me/.app free, no competitor) — but reads
"unglamorous baitfish," not sleek.

**Round 12 — concept coinages (12):** retent, mnesis, cortiq, **remnal**, retica,
datom, noeta, memra, mentiq, cognet, receva, notic.
→ **remnal = MINOR NOISE, solid** (.ai/.me/.app/npm/GitHub all free). All root-based
ones convergently taken by live AI products.

**Round 13 — obscure elements (12):** niobium, tantalum, rhenium, erbium, promethium,
bismuth, osmium, terbium, holmium, thulium, ytterbium, ruthenium. 0 clean (metals
industry owns .com, GitHub handles are active devs, .ai premium, voice-unspellable).

**Round 14 — generated opaque coinages.** Three generator agents (soft-premium /
crisp-minimal / classical-hybrid registers) invented + pre-screened ~330 coinages
against npm+GitHub+.ai; GitHub was the binding gate (~90% of short pronounceable
handles taken). ~30 survivors; the strongest 15 were confirmation-vetted. Of those,
5 hid live namesakes the fast screen missed (Servova, Klervo, Navrel, Norstra, Tenavo).

### Shortlist B — techy coinages (the "available + techy-register" set)

All ten: **.ai + .me + @scope + GitHub org free**, no in-category exact-name product;
each has one soft caveat. All are *invented* (no real techy word was free).

| # | Name | Register / root | Soft caveat |
|---|---|---|---|
| 1 | **Drovon** | crisp, engineered (photon/neutron feel) | Droven.io near-name; "Draven"; .com parked |
| 2 | **Nectova** | "connect" (L. nectere) — on-theme | "Nektova" (k) homophone; faint biotech -ova |
| 3 | **Vincova** | "bind" (L. vincire) — on-theme | one letter from Vinnova (SE innovation agency); .com parked |
| 4 | **Remnal** | opaque, Modal/portal register | "renal" autocorrect/mishear; meaning-light |
| 5 | **Zemvo** | punchy Z-forward | "Zenvo" hypercar; punchy > sophisticated; .com $2.7k |
| 6 | **Drenvo** | crisp DR-onset | drenvo.com = unrelated Shopify brand; opaque |
| 7 | **Texeva** | "weave" (L. texere) — on-theme | near-homophone "Pexeva" (antidepressant) |
| 8 | **Tessova** | "mosaic tile" (L. tessera) — on-theme | frozen jewelry store holds .com; crowded "Tess-" |
| 9 | **Larnel** | warm-premium, soft | reads as a first name ("Larnell"); .com parked |
| 10 | **Arceva** | "vault/ark" (L. arca) | exact name of a marketed antimalarial + "Tarceva" — pharma-flavoured |

Benched: Tesvo (tesvo.app live app; Tesco/Tesla bleed). Pre-screened but un-vetted
bench: Condeva, Legeva, Ligeva, Vornel, Sorvin, Surnel, Dovren, Dovrel, Klervel,
Klemvo, Grenvo, Plervo, Blervo.
Recommendation within B: **Drovon, Nectova, Vincova** (cleanest register + fewest
snags); **Remnal** for the fully-clean asset set. Note the two families —
-ova/-eva coinages carry *meaning* but a faint pharma tint; -vo/-el/-al coinages are
crisper but opaque.

## 13. Decision state

Two shortlists exist; they optimise for different things:

- **Shortlist A (evocative)** — meaningful, on-theme, but reads literary/cozy. Best
  *available meaningful* options anywhere. Lead: freshet / snickelway / florilegium.
- **Shortlist B (techy)** — modern/sophisticated *sound*, but all invented and
  meaning-light, each with a soft caveat. Lead: Drovon / Nectova / Vincova / Remnal.

No name has cleared as CLEAN (zero-caveat) — the category is too contested. Every
finalist is MINOR NOISE (ship-able with one known asterisk). **Before committing** to
any: confirm .ai/.me actually register at checkout (RDAP-free ≠ guaranteed / non-
premium), claim the npm org + GitHub handle (most techy picks need a `<name>hq`-style
org variant), and run a 5-minute USPTO/EUIPO wordmark pass (Arceva/Texeva sit near
pharma marks; the evocative names are clear of software marks).

Decision is **open**: pick a register (meaningful-but-literary vs techy-but-opaque),
then a name, then run the §9 action checklist for it.

## Appendix C — full candidate ledger (Part II)

Verdict · killer. MN = MINOR NOISE (qualifies). ✅ = made a shortlist.

```
EVOCATIVE / REAL-WORD
engram        DEAD  Engram $600M AI-memory startup (Karpathy)
memex         DEAD  memex.ai + WorldBrain Memex OSS + SAS trademark
mnemo         DEAD  Mnemo.ai + mymnemo 500k users + 374★ OSS + MNEMO cybersec
rune          DEAD  Rune AI Inc (YC, chat-to-build) + Rune lang + THORChain
mneme         RISKY 2× Mneme AI notes + OSS memory-layer clone; silent-m
lore          RISKY withlore.ai + Lore fandom $1.1M + lorejs
seshat        RISKY Seshat Labs (Web3/AI) + Seshat history databank
nabu          RISKY Nabu Casa + nabu.co.nz AI-KB + nabu.me AI platform
loam          RISKY loam.ai consultancy + Loam Bio agtech
minne         RISKY GMO Pepabo marketplace + Scandinavian dict; .ai free
amanu         DEAD  amanu.ai = AI knowledge-base product (same category)
scriv         DEAD  scriv.ai = private chatbot for your data (same category)
anamne        DEAD  anamne.ai = clinical AI SaaS
memini        DEAD  npm memini = "memory for AI coding agents"; all domains gone
noesa         RISKY NOESA cosmetics + Noesis AI wall; .ai dark
scriva        RISKY SCRIVA report-writing SaaS; .ai parked
camena        RISKY Camena Bioscience + cosmetics; .ai parked
amne          RISKY parses "without-memory" (amnesia); org blocked
recolla       RISKY "Recall" AI-memory swamp + org squat
reminia       RISKY "Remini" look-alike + org squat; domains free
archivist     RISKY myarchivist.ai + whole archives-software vertical
curator       RISKY Apache/ES Curator + saturated "Curator AI" niche
registrar     RISKY "domain registrar" semantic swamp for devs
chronicler    RISKY chronicler.io second-brain + Google Chronicle
seneschal     RISKY seneschal.ai stealth AI holds .ai + .me
chatelaine    RISKY Chatelaine magazine (1928) + npm same-pitch squat
castellan     RISKY OpenStack Castellan lib + security-vendor cluster
quaestor      RISKY @quaestor npm taken + PyPI "AI-dev context" clone
factotum      RISKY Snowplow Factotum OSS + Plan 9 auth-agent + Bukowski
bursar        RISKY means "college finance office" — wrong category
sacristan     RISKY no competitor; .me/.app free, .ai parked; church/actor SEO
tabellion     RISKY MS Research "Tabellion" + legal app; MSR namesake
cairn         DEAD  cairn.ai AI product + cairn.info; .me premium
tarn          DEAD  tarn.ai live + tarn.co Salesforce AI Agent + Knex pool lib
fen           DEAD  3-letter premium domains; FEN = chess notation
magpie        RISKY Magpie Photos&Notes app + Magpie AI cos; org blocked
jackdaw       RISKY OSS DAW + pentest tool; domains held by domainer
lodestar      DEAD  @lodestar npm = ChainSafe TS OSS; .ai hosts spam
sable         DEAD  withsable.com $45M Sequoia (voice+agent) 2 days prior
basalt        RISKY getbasalt.ai Series-A AI-agent platform; Obsidian-derivative
flint         RISKY flintk12 YC $15M Claude-powered + flint.com Sandberg AI
heron         RISKY Heron Data YC $16.6M + Apache Heron + IBM Heron
warren        RISKY Warren fintech + heywarren.com "Warren AI" (has a KB)
marten        DEAD  MartenDB + "Martin" YC AI-assistant homophone (voice)
rhizome       DEAD  Rhizome AI (YC W26) + rhizomeai.app KB + Rhizome.org
mycelium      DEAD  mycelium.id near-clone vault + BTC wallet + mycelium.ai
coppice       DEAD  coppice.ai + macOS PKM "Coppice" ("forest of ideas")
tilth         DEAD  npm tilth = same-category AI MCP tool; "filth"
tendril       DEAD  Ivy Tendril (AI agents) + Uplight $1.5bn
skein         RISKY Skein hash + Hadoop tool; domains taken; SKAYN/SKEEN
oriel         RISKY oriele.ai + oriel.ing AI QA dev-tool
spinney       RISKY .ai $15.5k + "Spinny" homophone; spinney.app live
caddis        RISKY caddis.app AI (May-26) + "Caddy" web-server clash
gloaming      RISKY .ai parked + "The Gloaming" band SEO
inglenook     RISKY .ai/.me likely free, no PKM rival; .app taken; twee
freshet    MN ✅    .ai + .me FREE, uncontested category
selvage       DEAD  selvedge.sh "memory for AI codebases" + AI code-review
heddle        DEAD  heddle.us "weaving AI" memory layer + getheddle.dev
runnel        DEAD  runnel.ai AI security + runnel.app video app
espalier      RISKY espalier.ai AI/knowledge-graph company
umbel         DEAD  Umbel $34M analytics + UMBEL KB ontology (same space)
brume         DEAD  brume.ai AI SaaS + Brume web3 wallet + "broom"
pleach        DEAD  pleach.ai AI agents (Claude Code) + reserved @pleach/mcp
reliquary     DEAD  Reliquary AI + npm secrets lib; churchy/morbid
whorl         RISKY Whorl app + biometric software; "whirl/world" homophone
spate         RISKY Spate.nyc YC AI + "a spate of crimes" connotation
corrie        DEAD  Coronation Street + person-name swamp
swale         RISKY no competitor; npm free but every domain parked/premium
twitten    MN ✅    .ai + .me + .app FREE, uncontested; "twit" echo
ginnel        RISKY .ai/.me taken; Ginnel Real Estate; soft/hard-g split
holloway      RISKY holloway.com = knowledge-publisher + Max Holloway UFC
moraine       RISKY npm SolidJS lib + Moraine Lake SEO + "marine" voice
drumlin       RISKY Drumlin Security DRM (20yr); .ai in redemption
shieling   MN ✅    .ai + .me FREE, no competitor; "shielding" voice
tombolo       RISKY .ai + .me FREE; Tombolo menswear + "tombola"; org variant
serein        DEAD  K-beauty brands + "serene" typo tax; domains taken
fettle        RISKY Fettle health/bike + fettle.app ERP; .ai parked
pintle        DEAD  pintle.ai AI consult + pintle.app dev-tools; archaic slang
cranny        RISKY .ai parked + Canny.io/Crenny/"granny" cluster
hummock       RISKY RisingWave "Hummock" engine + .ai premium + "hammock"
bothy         RISKY .ai/.me parked; MBA + candle brands; org taken
howff      MN ✅    .ai + .me FREE, no competitor; "huff" homophone
esker         RISKY Esker SA €205M AI software company (AP/AR)
bield         RISKY .ai $38.9k + bield.app live; "build" typo (dev)
twitchel      RISKY .ai/.me/.app free; "twitchy"; org = active dev
snickelway MN ✅    .ai+.me+.app+npm+GITHUB all FREE, uncontested (cleanest)
holt          RISKY Henry Holt publisher + holt.app SaaS; .ai premium; "hold"
withy         RISKY all domains taken; "withy AI" ≈ "with AI" (voice)
catena        DEAD  Catena Labs AI-finance + Catena Media; all premium
bothan        RISKY @bothan/.ai/.me/.app free; "many Bothans died" (Star Wars)
kame          RISKY Sakana AI "KAME" voice-AI (same cat) + "came" homophone
ostracon      DEAD  OstraconAI + ostracon.me = personal-wiki KB (same cat)

TECHY / SOPHISTICATED
corpus        DEAD  corpus.ai $1.295M + Corpus Software; generic NLP magnet
lemma         RISKY adtech Lemma owns .com; "lemme/let me" voice; .ai premium
lexeme        RISKY lexeme.app academic tool; .ai held; org squat
quiver        DEAD  Quiver dev-notes app (same cat) + QuiverAI a16z $8.3M
topos         RISKY Topos Institute + Topos geo-AI; all domains parked
apsis         RISKY APSIS email/CX SaaS ("AI-driven"); domains premium
corundum      RISKY Corundum FPGA-NIC OSS owns org; corundum.ai live
feldspar      RISKY Feldspar Haskell DSP language owns org; .ai parked
vernier       DEAD  Vernier Science Ed + npm agent-tool; all domains live
chamfer       RISKY SmartAI/Chamfer AI-CAD agent (shipped yesterday); .ai parked
kerf          DEAD  Kerf column-DB/language; all domains parked/premium
spandrel      DEAD  trevorfox/spandrel = markdown-KB-over-MCP (same cat) + chaiNNer 310★
ferrite       RISKY Ferrite Recording Studio app; domains parked; "ferret"
ephemeris     DEAD  ephemeris.ai astrology chat-AI + Swiss Ephemeris; "ephemeral"
collet        RISKY npm collet = ACP agent SDK; collect/collate homophone swamp
swarf         DEAD  swarf.app AI-CNC assistant; "waste" meaning; .ai parked
mandrel       DEAD  Red Hat Mandrel/GraalVM + npm = Claude-Code framework
olivine       RISKY useolivine AI + Olivine energy; .ai $25k
quiesce       DEAD  quiesce.me = personal wiki (same cat); "acquiesce"; .ai for-sale
spinor        DEAD  Spinor GmbH; "spinner" homophone; all domains taken
knurl         RISKY Knurling-rs + npm GUI lib; .ai parked; silent-k unspellable
cermet        RISKY whole materials industry; "Kermit" homophone; .ai parked
gabbro        RISKY gabbro.ai privacy-tech co; org squat
ferrule       RISKY @ferrule scope = "Ferrule" language; .ai/.me free; fiber-optic SEO
hysteresis    RISKY .ai parked + org=active dev; 10-letter spell-from-hearing
remanence     RISKY npm + .me free, no competitor; .ai parked; spell-from-hearing
etalon        RISKY Etalon Group + all domains premium; "echelon" homophone
mortise       RISKY mortise.me = self-hosted-K8s dev tool (same framing); "mortis"
tenon         DEAD  Tenon.io a11y tool + WP AI builder; .ai $39,895
pawl          RISKY pawl.ai pet-health app; "Paul" exact homophone (voice)
detent        RISKY detent.ai "Proof-Carrying AI"; org squat
fresnel       RISKY @artsy/fresnel React lib; silent-s voice-hostile
cepstrum      RISKY Cepstrum Labs AI on .ai; hard/soft-C unspellable
gudgeon    MN      .ai/.me/.app FREE, no competitor; baitfish/"gullible", org squat
albedo        DEAD  Albedo satellite startup + Genshin char; all domains taken
anneal        RISKY anneal.ai (Dialtone AI) + npm TS runner; "a kneel"
niobium       RISKY Niobium Microsystems (FHE dev-co) owns .ai + .app
tantalum      RISKY .ai premium + org=active dev + conflict-mineral + "tantrum"
rhenium       RISKY Rhenium Alloys + org=Ruby dev; .ai $30k; rh- unspellable
erbium        DEAD  Node 12 codename + erbium.com SaaS + "Erbium Stealer" malware
promethium    DEAD  promethium.ai AI-data co + Prometheus confusion + radioactive
bismuth       DEAD  BismuthCloud AI-agent-for-devs (same cat) + KDE Bismuth 2.4k★
osmium        RISKY OSM libosmium tool + osmium.chat + investment metal
terbium       RISKY terbium.ai IT firm + Terbium Labs (Deloitte)
holmium       RISKY medical-laser SEO + .ai for-sale + org squat
thulium       RISKY thulium.com Polish AI SaaS owns .ai + org; "Thallium" poison
ytterbium     RISKY .ai for-sale + org=active dev; "Yt-" unspellable
ruthenium     RISKY .ai for-sale + org=active dev; 4-syllable, voice-clunky
retent        RISKY Retent iOS memory app (exact concept); .ai $78k
mnesis        RISKY mnesis.ai + mnesis.com live AI companies; silent-m
cortiq        RISKY cortiq.ai = live macOS AI assistant (exact name)
remnal     MN ✅    .ai/.me/.app/npm/GitHub all FREE; "renal" echo; opaque
retica        DEAD  4 live businesses (retica.ai doc-AI, retica.me AI journal)
datom         RISKY Datomic "datom" term + npm active; all domains taken
noeta         RISKY noeta.ai brand + "Noeta Cloud" MCP agent (same cat)
memra         DEAD  memra.ai "sovereign agent + memory" (same cat) + @usememra
mentiq        RISKY mentiq.ai AI-fraud + mentiq.app; Azerbaijani "logic"
cognet        DEAD  cognet.ai "augmenting cognition" KB workspace (same cat)
receva        RISKY npm/GitHub/.ai/.me free; Recuva/Reciva confusion cluster
notic         RISKY notic.app save/organize app (same cat) + Notion knockoff

TECHY COINAGES (generated + confirm-vetted)
Servova       RISKY servova.com = live passkey product (fast screen missed)
Klervo        RISKY klervo.com = live field-service SaaS; K/C voice ambiguity
Navrel        RISKY GDIT "NavRel" data/dev product (exact); "navel" misread
Norstra       RISKY Norstra Consulting (AI firm) owns .com; Nostra/Norstar bleed
Tenavo        RISKY tenavo.app HR SaaS + Tenavo appliances + Tenova twin
Tesvo         MN    tesvo.app live app + TESVO e-bike; Tesco/Tesla bleed (benched)
Drovon     MN ✅    clean assets; Droven.io near-name + "Draven"; .com parked
Nectova    MN ✅    clean assets; "Nektova" homophone; faint biotech -ova
Vincova    MN ✅    clean assets; Vinnova (SE agency) 1-letter; .com parked
Zemvo      MN ✅    clean assets; "Zenvo" hypercar; .com $2.7k
Drenvo     MN ✅    clean assets; drenvo.com = unrelated Shopify brand
Texeva     MN ✅    clean assets; "Pexeva" (antidepressant) near-homophone
Tessova    MN ✅    clean assets; frozen jewelry store holds .com; "Tess-" crowded
Larnel     MN ✅    clean assets; reads as first name "Larnell"; .com parked
Arceva     MN ✅    clean assets; but exact name of a marketed antimalarial + Tarceva
```

## Appendix D — Part II sources / method

- Screening per candidate: `registry.npmjs.org/<name>` + `@<name>` scope · GitHub
  `api.github.com/users/<name>` (+ web profile when API rate-limited) ·
  RDAP `rdap.org/domain/<name>.{ai,me,app,com}` + DNS `host` + HTTP fetch · web search
  for company/product/dev-tool/pharma/foreign-language.
- Coinage generation: 3 register-specialised generator agents (soft-premium /
  crisp-minimal / classical-hybrid) invented + fast-screened ~330 candidates; the
  binding gate was GitHub (~90% of short handles taken). ~30 survivors, 15
  confirmation-vetted (which surfaced 5 live namesakes the fast screen had missed).
- Verdict scale: CLEAN (0 caveats — none achieved) > MINOR NOISE (ship-able, 1 soft
  caveat) > RISKY (a real blocker) > DEAD (multiple / same-category exact-name).
- Not yet done (do before committing to any pick): live checkout-price check on
  .ai/.me (RDAP-free ≠ standard-price); npm-org + GitHub-org claim; USPTO/EUIPO/UK-IPO
  5-min wordmark pass; for techy picks, decide the `<name>hq` org-handle variant.

---

# Part III — Sophisticated-tech round (2026-07-19)

Feedback on Shortlist B: the `-ova/-vo/-eva` coinages (Nectova, Zemvo, Texeva…)
read as generic pharma / B2B-SaaS syllable-salad, not "sophisticated." This round
re-ran generation in three registers aimed squarely at the **Vercel / Linear /
Notion / Sentry / Warp / Axiom / Cortex** feel, then hard-vetted with live-site
probes (not just registry checks — the piece Part II's fast screens skipped).

## §14 — What the three lanes proved

- **Real-word repurposing (Etymon/Ambit/Tenet school):** the crisp single-real-word
  register is saturated — bare GitHub org taken for *every* dictionary word (even
  `scholia`, `colophon`); `.com` + `.ai` taken for every one. Survivable only via a
  `getX`/`Xhq` org variant + a bought domain (which is how Notion→`makenotion`,
  Warp→`warpdotdev`, Sentry→`getsentry`, Axiom→`axiomhq` all live). `.me` is the
  only discriminating TLD — free only on the obscure words.
- **Crisp minimal coinage (Vercel/Retool school):** the productive lane. Short
  trace/instrument/particle coinages (Traxel, Sondel, Kenon) dodge the squatting
  and still read as native dev-tool terms.
- **Classical roots:** plain classical words are 100% squatted; forged compounds
  clear namespaces but the `-uron` cluster (menturon/noduron) is pharma-herbicide
  adjacent (diuron/linuron) → same failure mode we're fleeing. Dropped.

## §15 — Live-namesake kills (fast screen had missed all of these)

Direct-site probe caught live **AI** products the generators' (budget-exhausted)
web search never saw:

| Name | Killed by |
|------|-----------|
| Etymon | **etymon.ai** = EtymonAI, live AI-for-GTM consultancy |
| Nekton | **nekton.ai** = Nekton, live AI automation platform |
| Vocable | **vocable.ai** = Vocable AI, live content-marketing AI |
| Praxon | **praxon.ai** → redirects to a live contract-ops product |

## §16 — Shortlist C (techy/modern/sophisticated · verified live-namesake-free)

Ranked by register × availability. Assets verified 2026-07-19: npm bare via
registry, GitHub via api, `.com` via Verisign RDAP, `.ai` via rdap.org (redirect
followed), `.me` via Identity Digital RDAP, live products via direct HTTPS fetch.

| # | Name | Root / read | Assets (npm·gh·.ai·.me·.com) | Register note | Caveat |
|---|------|-------------|------------------------------|---------------|--------|
| 1 | **Traxel** | trace + voxel; "a pixel of your thought-trail" | npm free · gh dormant · .ai+.com registered-but-**dark** (no live site) · **.me free** | native graphics/dev-primitive sound; TRAX-el = Vercel cadence | .ai/.com held-but-unused (buyable or ignore); use `traxel` npm/`gettraxel` gh |
| 2 | **Sondel** | sonde + -el; instrument that sounds the depths | npm free · gh dormant · **.ai free · .me free** · .com = old dark server | crisp Vercel shape; only pick with `.ai` actually unregistered | meaning oblique; surname (no tech namesake) |
| 3 | **Ordexis** | order + index blend; structure/recall | npm free · **gh free · .ai free · .me free** · .com = for-sale listing | reads structured/technical | `.com` on a brandable marketplace (buyable); mild `-exis` suffix |
| 4 | **Cognomex** | Lat. *cognomen* (gno- = to know/name) | **npm · gh · .ai · .me · .com ALL free** | only zero-gap namespace on the board | register leans enterprise (Vertex/Rolex cadence) |
| 5 | **Tenax** | Lat. "holding fast, tenacious" = memory that grips | npm free · gh dormant · .ai parked · .me+.com taken | best pure meaning; hard T-N-X, Brex/Onyx school | domains held by Tenax industrial-netting maker (non-software) → variant + buy |
| 6 | **Kenon** | *ken* (knowledge) + -on particle (boson/gluon) | npm free · gh dormant · **.me free** · .ai/.com dark | physics-particle sound, techy | Kenon Holdings (NYSE energy, non-software) brand collision |
| 7 | **Stet** | proofreader's "let it stand" = keep this | npm free · gh handle active · .ai/.me/.com taken | 1 syllable, spells itself from voice, Arc/Zed minimalism; elite meaning for a note-keeper | domains + gh taken → `getstet`/`usestet` + buy; dead FSF "stet" tool (2006) |
| 8 | **Ambit** | "scope / sphere / range" | npm+all taken | pure Vanta/Ramp register | variant + domain buy; Ambit Energy (non-software) only namesake |
| 9 | **Tenet** | "a principle held to be true" | npm+all taken | crisp, serious | variant + buy; Nolan film + Tenet Health (non-competing) |
| 10 | **Conspectus** | "a survey/overview of an entire subject" | npm bare taken · .ai parked · **.me free** | *literally what a second brain gives you*; sober Latin | 3-syllable/formal; use scope + `.me`, buy `.ai` off parking |

**Read:** #1–4 are claimable today with little/no domain spend (Cognomex = the one
fully-open stack; Traxel = the best-sounding of them). #5–7 are the strongest
*names* but cost a domain purchase and/or an org-handle variant. #8–10 are
register-perfect real words with no same-category namesake, gated only on the
usual variant+domain-buy that every real-word tech brand pays.

**Recommendation:** if namespace-clean-today matters most → **Traxel** (best sound)
or **Cognomex** (zero gaps). If you'll pay for a domain to get the best *name* →
**Tenax** (meaning) or **Stet** (voice + minimalism). Same pre-commit checklist as
Appendix D applies to whichever is chosen.

## §17 — Shortlist D (second sophisticated batch · 2026-07-19)

Same brief, another 12-per-lane round, deduped against A/B/C and all kill lists.
Two registers held up: erudite-but-sober real words (Almagest/Sextant/Rostrum) and
crisp materials/optics/particle coinages (Kovar/Fovel). All 10 below live-probed
(direct HTTPS fetch) — no live software/AI namesake.

### Live-namesake kills this round
| Name | Killed by |
|------|-----------|
| Chronon | **chronon.ai** = live OSS ML feature platform (Airbnb/Stripe/Netflix/OpenAI/Uber) — dev-tool, direct adjacency |
| Texton | **texton.com** = live 85-yr window-treatment maker + one letter from Textron (defense) |
| Telic | live cert on **telic.ai** + Telic footwear + UK "Op Telic" |
| Parlax | ambiguous live server; sound-proximity to Parallax Inc |

### Shortlist D
| # | Name | Root / read | Assets (npm·gh·.ai·.me·.com) | Register note | Caveat |
|---|------|-------------|------------------------------|---------------|--------|
| 1 | **Almagest** | Ptolemy's "The Great Compilation" — a compendium of all knowledge | npm free · gh taken · .ai parked · **.me free** · .com taken | Cortex-tier gravitas; = second brain literally | erudite/obscure; al-muh-JEST spell-from-hearing mild |
| 2 | **Fovel** | fovea + -el — point of sharpest focus | **npm · gh · .ai · .me free** · .com dead-cert | only fully-free namespace in 2 coinage rounds | meaning thin; pure coinage |
| 3 | **Kovar** | glass-to-metal sealing alloy (joins unlike things) + Czech *kovář* = smith | npm free · gh taken · .ai empty · **.me free** · .com taken | techy-materials sound | Kovar alloy trademark (physical goods) |
| 4 | **Rostrum** | a platform for public speaking | npm taken · gh taken · .ai empty · **.me free** · .com taken | on-the-nose for a **voice**-first product | Rostrum PR agency / record label (non-competing) |
| 5 | **Sextant** | instrument to fix your position by the stars | all bare taken; no same-category namesake | crisp, distinctive; "find your bearings in your knowledge" | variant + domain buy; Sextant Studios/Stays (unrelated) |
| 6 | **Dictum** | "a thing formally said" — a maxim | all bare taken; no same-category namesake | tight Latin, Vanta-register | variant + domain buy; Dictum GmbH tools (non-software) |
| 7 | **Cistern** | reservoir you draw on later — store/recall | npm taken · **.me free** | clean store metaphor | faint plumbing connotation |
| 8 | **Armature** | internal framework everything hangs on | npm taken · **.me free** | structure/scaffold sense | Armature Studio (games, not PKM) |
| 9 | **Corollary** | "a proposition that follows necessarily" | npm taken · .ai for-sale (buyable) · **.me free** | logic/Axiom register | 4 syllables |
| 10 | **Aquifer** | hidden layer that stores and yields water | npm taken · **.me free** | evocative recall metaphor | Aquifer.org med-ed nonprofit (non-competing) |

**Read:** #1–3 are claimable with little spend (Fovel = fully open; Almagest/Kovar =
npm + `.me` free). #4–10 use a scope + `.me` and/or a bought domain. **Almagest** is
the standout on meaning ("the great compendium" ≈ second brain), **Fovel** on
availability, **Rostrum** on voice-first fit, **Sextant/Dictum** on pure crisp
register. Bench (screened-clean, not in the 10): Zamak, Scripton, Monel, Quadrel,
Cistern's cousins. Same Appendix D pre-commit checklist applies to any pick.

## §18 — Shortlist E (third sophisticated batch · 2026-07-19)

Fresh veins: navigation instruments, typography/print, acoustics-of-speech,
geology-strata, metallurgy/thermocouple alloys, math-logic. Deduped against A–D +
all kills. Every entry below live-probed (direct HTTPS fetch) — no live namesake.
This round was the harshest for missed live products: the fast screen's known-
namesake column passed **five** names that direct-probe then killed (below), a
textbook demonstration of Law 6.

### Live-namesake kills this round
| Name | Killed by (direct probe) |
|------|--------------------------|
| Glyphon | **glyphon.ai** = live agentic-AI orchestration platform (DoD/FedRAMP) |
| Sonorant | **sonorant.ai** = live conversational-AI platform (app.sonorant.ai) — voice-adjacent |
| Pilcrow | **pilcrow.ai** = live AI live-chat for Shopify |
| Litz | **litz.ai** = live AI consulting practice |
| Noema | **noema.ai** = live enterprise-AI governance platform |
| Karst / Stratum | .ai redirects to a live brand site (brandsxkarst / stratum.gs) — downgraded |

### Shortlist E
| # | Name | Root / read | Assets (npm·gh·.ai·.me·.com) | Register note | Caveat |
|---|------|-------------|------------------------------|---------------|--------|
| 1 | **Alumel** | thermocouple wire that turns heat into a signal | **npm · gh · .ai · .me free** · .com for-sale | best availability of any name in 5 rounds | alloy trademark (physical); aluminum echo; AL-u-mel/a-LOO-mel stress wobble |
| 2 | **Morpheme** | the smallest unit of *meaning* in language | npm free · .ai dead (404) · **.me free** · .com taken | atomic unit of a knowledge system; Cortex-tier | linguistics-jargon; obscure to laypeople |
| 3 | **Galvon** | galvanic + -on — the spark that registers a response | **npm · .ai · .me free** · .com dead | particle-school (Kenon sibling), techy | meaning thin; pure coinage |
| 4 | **Timbrel** | timbre + -el — voice resonance | **npm · .ai · .me free** · .com taken | on-theme for a **voice**-first product | biblical frame-drum register |
| 5 | **Chromel** | thermocouple sensing wire (pairs with Alumel) | **npm · .ai · .me free** · .com dead | instrument heritage; two-product family option | Chrome-adjacency; alloy trademark |
| 6 | **Ligature** | a stroke *joining* two letters — a bond/tie | npm taken · .ai dead · **.me free** | typographic, connection-between-ideas | none in AI/PKM; clean |
| 7 | **Colophon** | the maker's mark at a book's end (who made it) | npm taken · .ai dead · **.me free** | authorship/provenance, bookish-crisp | Colophon Foundry (type, non-competing) |
| 8 | **Geode** | a plain stone with crystals hidden inside | npm taken · .ai dead · **.me free** | knowledge concealed within; clean voice | Geode Capital / Health (finance/health, non-SW) |
| 9 | **Alidade** | the sighting rule that measures bearings | npm taken · .ai empty · **.me free** | "orient yourself in your own knowledge" | Alidade MER (healthcare consulting, non-SW) |
| 10 | **Isomorph** | a thing with the *same structure* as another | npm taken · .ai for-sale · **.me free** | structure-preserving map; Axiom register | long/jargony |

**Read:** #1 (Alumel) and #3–5 (Galvon/Timbrel/Chromel) are claimable today with
`.ai` + `.me` in hand. #2 (Morpheme) has the strongest meaning + npm/`.me` free.
#6–10 use a scope + `.me` (+ optional bought `.ai`). Bench (screened-clean):
Phoneme, Sediment, Orrery, Incipit, Recto, Sigla. Same Appendix D checklist applies.

## §19 — Shortlist F (fourth sophisticated batch · 2026-07-20)

Veins: neuro-anatomy (literal brain), horology/clockwork, archive/library-science,
math, plus hydrology/pigment coinages. Deduped against A–E + all kills. All entries
live-probed. Availability was the best of the campaign (many npm + `.me` free; one
five-for-five), but the live-namesake tax held — three more killed on probe.

### Live-namesake kills this round
| Name | Killed by (direct probe) |
|------|--------------------------|
| Libration | **libration.ai** = live "AI Campus Continuity OS" |
| Shelfmark | **shelfmark.com** = live AI visual-inspection software |
| Detent | **detent.ai** = "Proof-Carrying AI" landing (name staked in AI space) |
| Mantissa / Tectum / Detron / Sepion | servers respond with TLS errors (unverifiable — treat as occupied) |

### Shortlist F
| # | Name | Root / read | Assets (npm·gh·.ai·.me·.com) | Register note | Caveat |
|---|------|-------------|------------------------------|---------------|--------|
| 1 | **Culvon** | culvert + -on — the hidden channel that routes flow beneath | **npm·gh·.ai·.me·.com ALL free** | five-for-five — the single most available name in the whole campaign | meaning oblique; pure coinage |
| 2 | **Fornix** | the brain's arched fiber-bundle in the **memory circuit** | npm free · .ai parked · **.me free** | the most on-brand meaning surfaced anywhere (literal memory pathway) | anatomical obscurity |
| 3 | **Fascicle** | a bundle/installment — knowledge in gathered sections (also a nerve-fiber bundle) | **.ai free · .me free** · .com = SEO junk (not a product) | only real word with both `.ai` + `.me` free | slightly bookish |
| 4 | **Myelon** | myelin — the insulation that makes nerve signals travel fast | **npm · .ai · .me free** · .com parked | fast-recall brain semantics; neuro-crisp | ~3 syllables; medical register |
| 5 | **Escapement** | the mechanism that regulates a clock's beat | npm free · .ai dead · **.me free** | horology — the regulated heart of a precision instrument | 3 syllables |
| 6 | **Striatum** | subcortical structure central to **learning & habit** | npm free · .ai dead · **.me free** | literal-brain, memory-formation | slightly clinical |
| 7 | **Sulcus** | a groove/furrow of the brain (pairs with gyrus) | npm free · .ai dead · **.me free** | crisp Latin, short | anatomical |
| 8 | **Striad** | striatum → procedural-memory structure (coinage) | npm free · .ai dead · **.me free** | STRY-ad hard cluster, brain-native | near "triad"; stress wobble |
| 9 | **Accession** | the archival act of recording a new item into a collection | npm free · .ai parked · **.me free** | "add to your archive" — library-science | formal/long |
| 10 | **Isochron** | a line of *equal time* — synchronization, steady cadence | .ai dead · **.me free** | geochronology/precision register | obscure/technical |

**Read:** #1 (Culvon) is uniquely claimable — every asset including `.com` is free.
#2 (Fornix) and #3 (Fascicle) are the meaning/availability sweet spot (memory
circuit; `.ai`+`.me` free). #4–8 are npm + `.me` free. **Fornix** is the on-brand
standout (it *is* the brain's memory pathway). Bench (screened-clean): Rasten,
Orpon, Pariton, Phoneme. Same Appendix D pre-commit checklist applies.

### Campaign status after 6 rounds (A–F)
~60 names vetted, ~55 techy (B–F). Structural finding holds and hardened: **no
zero-caveat name exists** in this category, and the live-namesake density is now so
high that the fast screen's known-namesake column misses a live AI product roughly
40–50% of the time — every round, the direct-probe pass kills 3–5 "clean" picks.
The remaining free space is almost entirely (a) oblique coinages (Culvon, Traxel,
Myelon) and (b) anatomically/technically obscure real words (Fornix, Fascicle,
Sulcus). Further rounds will keep returning names of this shape; the decision is now
a taste call among the ~15 leads across C–F, not a coverage problem.

## §20 — Shortlist G (`.me` domain hacks · 2026-07-20)

Different pattern by request: the brand **is** the full domain `word.me`, where the
word + `.me` reads as a phrase and `.me` = the user / the self / your second brain
(à la better.me, augment.me). Imperative-verb + me = what the agent does *for you*;
comparative-adjective + me = "a more-X you." The gate flips: the `.me` must carry
**no live product** (parked/for-sale is fine — it's buyable); npm/GitHub are
secondary (a `@scope`/`get<word>` variant covers the bare word). All entries below
live-probed.

### Live-product kills (occupied `.me`)
| Phrase | Killed by |
|--------|-----------|
| second.me | **Second Me** (Mindverse AI) — a *personal-AI avatar* platform, direct category hit |
| retain.me | live customer-retention marketing SaaS |
| surface.me | → Surface magazine + Microsoft Surface |
| align.me | live B2B sales/marketing agency |
| glean.me | Glean (enterprise-search AI) — direct same-category namesake |
| anchor.me | held inside Yahoo/Oath infra; Anchor (Spotify) |
| thread.me / forge.me / clarify.me | Meta Threads / Laravel-Atlassian Forge / Clari — crowded namesakes |
| clearer.me | "launching soon" — impending live product |

**Availability finding:** every *natural short imperative* is already taken —
orient/ground/brief/distill(bare)/recall/augment/attune/curate/nudge/cue all
registered (`.me` is a heavy personal-brand TLD). The clean free landing-phrases are
(a) longer/rarer memory-process verbs and (b) comparative "a more-X you" adjectives.
RDAP-free `.me` = guaranteed no live product (domain doesn't resolve at all).

A wider RDAP sweep (187 `.me` candidates across the two generators) put the free
rate at ~7.5% — the `.me` single-word namespace is ~93% domained. Survivors skew to
derived/prefixed verbs (re-, en-, -ize) plus a few punchy exceptions.

### Shortlist G
| # | Phrase | Reads as | `.me` status | Register / fit | Caveat |
|---|--------|----------|--------------|----------------|--------|
| 1 | **past.me** | "past me" leaves notes for future-me | **free** (.ai for-sale) | the dev "past-you/future-you" idea *is* a second brain; 1 syllable, needs zero explanation | npm/gh bare taken (variant) |
| 2 | **internalize.me** | "internalize me" — make this part of me | **free** (npm bare free) | the literal verb for building a second brain | 4 syllables |
| 3 | **epitomize.me** | "epitomize me" — capture my essence | **free** (**npm + gh bare also free**) | epitome = an abridgment of a larger work; uniquely clean full stack | 4 syllables |
| 4 | **augment.me** | "augment me" — augmented cognition | registered, **no live site** (approach holder) | the user's own example; iconic + techy | not confirmed for-sale |
| 5 | **resurface.me** | "resurface me" — spaced-repetition recall | **for-sale (buyable)** | best conceptual fit for a recall product | premium price likely |
| 6 | **distill.me** | "distill me" — distill my thinking | **free** | sophisticated; summarize/refine | mild distill.io namesake |
| 7 | **cement.me** | "cement me" — lock into long-term memory | **free** | crisp single word; consolidation metaphor | npm/gh bare taken (variant) |
| 8 | **metabolize.me** | "metabolize me" — digest into knowledge | **free** (npm bare free) | distinctive "process what you consume" | 4 syllables |
| 9 | **backfill.me** | "backfill me" — fill the gaps in my record | **free** | dev-native infra verb; serious Warp/Vercel tone | npm bare is an active pkg (variant) |
| 10 | **engross.me** | "engross me" — captivate + write to final form | **free** (npm bare free) | double meaning = chat-capture → canonical record | mild "gross" substring |

**Read:** nine of ten are **registrable today** (only augment.me is held; resurface.me
is a paid buy). By angle: instant-clarity → **past.me** (everyone) / **backfill.me**
(developers); most on-brand → **internalize.me**; cleanest full stack (`.me`+npm+gh)
→ **epitomize.me**; strongest recall concept → **resurface.me**. Bench (free `.me`):
interleave.me (interleaving = a memory technique), ingrain.me (Ingrain-AI namesake),
ground.me, ramify.me (knowledge-graph), cement.me's cousins, keener.me/broader.me
(better.me comparatives). Avoid the stem entirely: **second.me** (Mindverse "Second
Me" AI-clone), recall.me (MS Recall). Same Appendix D checklist for any pick.

## §21 — Full check: past.me (2026-07-20)

Verdict: **registrable and legally unblocked, but MINOR-NOISE→RISKY** — premium
price, a crowded "past me" journaling niche, and a backward-looking positioning
mismatch are the real caveats.

**Domain / namespace**
- `past.me` — RDAP-free, **but almost certainly registry-PREMIUM** (short dictionary
  word). Premium `.me` = one-time upfront fee (2025 premium sales averaged €6,544),
  then standard ~$17–24/yr renewal. Exact price only visible at a registrar
  checkout. Registrable, not reserved-blocked.
- npm bare `past` = taken → use `@past` scope (or `pastme`/`past-me`, both free).
- GitHub `past` + `pastme` = taken → `getpast` / `usepast` / `pastdotme` / `past-me`
  all free (standard `getX` variant path).
- Adjacent TLDs: past.ai = parked/for-sale (buyable); past.dev = free; past.com =
  parked (Digimedia portfolio); past.io → PastBook (photo books); **past.app = a
  live "Past" clipboard-history app**.

**Namesake / collisions** (codex web research, WebSearch budget was exhausted)
- **past.app "Past"** — offline clipboard-history/search utility, launched 2024,
  $15/yr or $50 lifetime, French, early-stage (~8 upvotes). Productivity-adjacent,
  NOT notes/PKB. Low threat but shares the bare one-word "Past". <https://past.app/>
- **PastMe.life** — LIVE exact-name "time-traveling journal" (capture moments,
  reconnect with your former self). <https://pastme.life/> This is who holds
  pastme.com / pastme.ai / github `pastme`.
- iOS "Dear Past Me" (journal resurfacing old entries) and "Past Me Rescue" (stores
  notes/media about past wins) — a small cluster of "past me" journaling apps.
- Net: the "past me / former self" phrase is already an occupied *journaling /
  nostalgia* niche, with one exact "PastMe" product.

**Trademark** — no LIVE registered wordmarks for PAST / PASTME / PAST.ME in software
(USPTO cls 9 & 42, EUIPO). "PAST" is descriptive/weakly-suggestive for memory
software → **weak protectability** (hard to own a strong mark). Not a full
common-law clearance. <https://tmsearch.uspto.gov/> <https://www.tmdn.org/tmview/>

**Voice / positioning**
- Homophone: "past" ≈ "passed"; spoken "past me" can hear as "passed me" — a minor
  wrinkle for a voice-first product.
- Positioning mismatch (the real strategic risk): "past.me" frames the product as
  *backward-looking* (your former self, journaling, nostalgia — exactly what
  pastme.life / Dear Past Me do), whereas the product is a *forward-working* active
  second brain you talk to now. The name may mis-signal "journal about my past."

**Recommendation** — clean enough to ship (no legal blocker, `.me` obtainable), but
it's not the zero-friction win the free RDAP suggested: budget for a premium
purchase, accept a crowded "PastMe" journaling neighbourhood, and weigh the
backward-looking read against the product's live-assistant framing. If that framing
matters, an augment/internalize/resurface-style name signals it better.

## §22 — Shortlist H (`.me` hacks, real + invented · 2026-07-20)

Explored the "`.me` = final syllable" hack (word reads as one word: beco.me,
resu.me, volu.me). Finding: those are ~all premium/taken/live — killed volu.me (live
fan-app), illu.me (→givepad), and the high-namesake ones (chi.me→Chime bank,
subli.me→Sublime Text, ideo.me→IDEO, the.me→403). Only mne.me / plu.me / lumi.me
survive. Combined with the strongest free `word.me` not already in Shortlist G's
headline ten. All live-probed / RDAP-verified.

Two productive seams: (a) `-me`-ending **real words** that survive as *parked/buyable*
(no live product) and (b) — the freshest answer to "invented" — the linguistics
**`-eme` unit coinage**: `<root>eme.me` reads as "gnoseme / toneme / glosseme" = "an
atomic unit of [knowledge/tone/gloss]", which maps exactly onto a second brain built
from small notes. Many `-eme` coinages are RDAP-free with npm+gh+.com **also** free —
the cleanest availability in the whole campaign.

### Shortlist H
| # | Domain | Reads as | Meaning / fit | `.me` status | Caveat |
|---|--------|----------|---------------|--------------|--------|
| 1 | **gnose.me** | "gnoseme" | a **unit of knowledge** (gnosis), coined on the lexeme pattern | **free** (npm+gh+.com **all free** — pristine) | coinage; -eme reads jargony to some |
| 2 | **tone.me** | "toneme" | real linguistics term + tone-of-voice (voice-first bonus) | **free** (npm/gh free; .com parked) | short, real; "tone" is broad |
| 3 | **glosse.me** | "glosseme" | a *gloss* = a margin note/annotation = what the app captures | **free** (.com/npm free; gh taken) | best note-taking pun; obscure word |
| 4 | **subsu.me** | "subsume" | absorb/integrate into a larger whole | **parked (buyable)** | most sophisticated real-word -me hack |
| 5 | **mne.me** | "mneme" | Greek for **memory** — most literally on-brand | registered, dark (approach holder) | cryptic spelling (m-n-e-m-e) |
| 6 | **plu.me** | "plume" | a quill / writing feather | **parked (buyable)** | Plume (WiFi) namesake, diff category |
| 7 | **noeti.me** | "noetime" | *noetic* (of the mind) + hidden "time" | **free** (npm/gh/.com all free) | double-meaning needs a beat to parse |
| 8 | **prosode.me** | "prosodeme" | a prosodic (speech-melody) unit — voice-native | **free** (npm/gh/.com all free) | obscure/technical |
| 9 | **lifeti.me** | "lifetime" | a lifetime of memory/knowledge | **parked (buyable)** | Lifetime (TV) — non-software |
| 10 | **consu.me** | "consume" | ingest/capture content & knowledge | **parked (buyable)** | faint consumerist read |

**Read:** the invented `-eme` coinages (**gnose.me / noeti.me / prosode.me**) are
**register-now free across .me+npm+gh+.com** — unmatched availability, at the cost of
being coinages. Real-word `-me` hacks (**subsu.me / plu.me / lifeti.me / consu.me**)
are parked → a domain buy, no live namesake. **mne.me** (= memory) is the on-brand
grail but held-dark. My three to build on: **gnose.me** (cleanest + clearest
"knowledge"), **glosse.me** (best note-taking pun), **tone.me** (real word + voice
angle). Bench (all free): cerebe.me (brain), sophe.me (wisdom), myste.me, rhy.me,
lexe.me, metrono.me, plus the verb-hacks interleave.me/ingrain.me/ground.me/
enshrine.me/keener.me. Killed (live/hard namesake): to.me (Tome AI), volu.me,
chi.me (Chime), subli.me (Sublime), fra.me (Frame.io), chro.me, praxe.me (Praxeme
Institute). Same Appendix D checklist.

## §23 — Shortlist I (`.me` unit-coinages + French knowledge-words · 2026-07-20)

The richest seam yet: `<root>eme.me` unit-coinages and real **French `-me` words**
where the domain reads as one word AND the concatenated word is free on npm + gh +
.com. Nine of the ten below are **fully pristine** (`.me`+npm+gh all free, verified
by direct RDAP/registry/API) — the best availability in the whole campaign. They
span the product's actual verbs: think / dictate / remember / capture / read /
narrate. Register skews French/linguistics-academic — sophisticated, but obscure to
English-first ears (pense/dicte/acade are the most accessible).

### Shortlist I
| # | Domain | Reads as | Meaning / fit | Assets | Caveat |
|---|--------|----------|---------------|--------|--------|
| 1 | **pense.me** | pensée / penseme | a **unit of thought** — Pascal's Pensées were atomic notes; also "pense-me" (think me) | **pristine** (.me+npm+gh free) | needs the French/philosophy read |
| 2 | **dicte.me** | dictée / dicteme | **dictation** → speak-to-capture; the voice-first fit | **pristine** | — |
| 3 | **mnese.me** | mneseme | a **unit of memory** (mnesis); flows as MNEH-seh-me (fixes mne.me's onset) | **pristine** | coinage |
| 4 | **capte.me** | capteme / capter | **capture a signal** — the product's first verb | **pristine** | coinage |
| 5 | **sapie.me** | sapieme | a **unit of wisdom** (sapience) | **pristine** | coinage |
| 6 | **lecte.me** | lecteme | a **unit of reading**; a "lect" = your personal language variety | **pristine** | obscure |
| 7 | **narre.me** | narreme | **real narratology term** — the atomic unit of narrative; your notes = the narremes of your life | **pristine** | obscure term |
| 8 | **acade.me** | academe | **academia / the world of learning** — real word | registered, dark (approach holder) | held-not-free |
| 9 | **episte.me** | episteme | **knowledge / the frame of knowing** — real word (Foucault) | registered, dark (approach holder) | held-not-free |
| 10 | **aphoris.me** | aphorisme | French for **aphorism** — a second brain as collected aphorisms | .me + npm free (gh taken) | longest domain |

**Read:** the seven pristine coinages give **full-stack naming freedom** — `word.me`
as the brand, the concatenated word for npm/@scope/GitHub/.com, register-now, zero
spend. Best of them: **pense.me** (thought), **dicte.me** (voice/dictation — arguably
the two halves of this exact product), **mnese.me** (memory). Real-word gravitas:
**acade.me** / **episte.me** (both = knowledge/learning, but held-dark → approach the
owner). Bench (also pristine): syntaxe.me (structure), onto.me ("on to me" / ontology
unit). Real-word bench (parked/buyable, no live product): theore.me (theorem),
overco.me (overcome), epito.me (epitome = essence/abridgment), syste.me (system) —
last two on domain marketplaces (premium). acade.me + episte.me independently
re-confirmed parked-dormant with no live product. Killed: taxe.me (reads "tax me"),
lexi.me (live gesture-AI), texte.me ("text me" SMS confusion), morphone.me (→
morphine), seme.me / rhe.me / supre.me (live companies). Same Appendix D checklist.

## §24 — Shortlist J (`.me` knowledge-vault nouns + neuro/recall coinages · 2026-07-20)

Two seams: real **"knowledge-container" words** (corpus/archive/lexicon/papyrus —
the actual vocabulary of a knowledge base) as parked/buyable `.me`, and fresh
**pristine coinages** for capture/recall/symbol. Deduped against G/H/I (skipped
dicto.me/mneste.me/noeto.me as near-dupes of Shortlist I's dicte/mnese/noeti). All
live-probed / RDAP-verified.

### Shortlist J
| # | Domain | Reads as | Meaning / fit | `.me` status | Caveat |
|---|--------|----------|---------------|--------------|--------|
| 1 | **corpus.me** | corpus | *a body of text/knowledge* — literally the term for a knowledge base | for-sale (buyable) | none same-category — cleanest |
| 2 | **archive.me** | archive | a store of records — **doubles as the command "archive me"** | parked, no DNS (approach owner) | Archive.org (non-competing) |
| 3 | **wisdo.me** | wisdom | accumulated wisdom | parked/dormant, no live product | Wisdo (community app) on .com |
| 4 | **lexicon.me** | lexicon | your vocabulary of knowledge | for-sale (buyable) | Lexicon (branding agency, non-competing) |
| 5 | **evoco.me** | evocome / evoke | *call forth* — recall as evocation; "evoke me" | **pristine** (.me+npm+gh free) | reads as one word or "evoke me" |
| 6 | **glyphe.me** | glypheme | *a unit of written symbol* (glyph) — the atom of a note | **free** (.me+npm+gh; .com parked) | coinage |
| 7 | **dendri.me** | dendrime | *dendrite* — the branch where a neuron **receives** signals (capture) | **pristine** (.me+npm+gh free) | visually near "dendrimer" (chemistry) |
| 8 | **papyrus.me** | papyrus | ancient writing surface | **for-sale, $500 confirmed** | Papyrus (font/stationery, non-software) |
| 9 | **upti.me** | uptime | your always-on second brain | parked, blank (approach owner) | "uptime" is devops-generic |
| 10 | **folio.me** | folio | a leaf/page of a book | parked, no DNS (approach owner) | Folio Society (books, non-competing) |

**Read:** register-now-free coinages → **evoco.me, glyphe.me, dendri.me**. Buyable
marketplace → **corpus.me, lexicon.me, papyrus.me** ($500 is the only *confirmed*
price in the campaign). Parked-dormant (approach owner) → **wisdo.me, archive.me,
upti.me, folio.me**. Best of batch: **corpus.me** (the literal word for a knowledge
base, no namesake), **archive.me** (noun + command double-read), **wisdo.me**
(wisdom). Bench (also clean): tablet.me (free), cache.me (buyable; "cash me"
homophone), tacte.me/phano.me (pristine coinages). Killed: **fatho.me** (Fathom AI
notetaker — direct same-category), annals.me (voice ≈ "anals"), anamne.me (live
.com), plus vault/codex/oracle/trove/canon/ledger/quill/psyche (big or live
namesakes). Same Appendix D checklist.

## §25 — Mixed-form identities (prefix per surface · 2026-07-20)

Key relaxation: the domain, npm scope, and GitHub org need NOT be the same string —
the brand is the spoken bare word, each surface just needs *a* free form (Sentry =
brand "Sentry" · npm `@sentry` · gh `getsentry` · `sentry.io`). So a name only dies
on a live same-category competitor or bad meaning/voice; pure availability is
solvable by mixing bare + `get`/`use`/`@scope` per surface. Verified: **every
`get<base>` GitHub handle tested is free**, and most strong bases (survivors of C–F,
i.e. no live namesake) have a free bare npm **or** a free `X.me`. Assembled identities:

| Base (brand) | Meaning | npm | GitHub | Domain | Cleanliness |
|--------------|---------|-----|--------|--------|-------------|
| ~~Fornix~~ | brain's memory circuit — but **DROPPED**: "fornication" derives from Latin *fornix* (brothels under arches); spoken "forni-" overlap is a snicker-risk for a voice-first brand | `fornix` (free) | `getfornix` | `fornix.me` (free) | killed — bad association |
| **Almagest** | "the great compendium" ≈ second brain | `almagest` (free) | `getalmagest` | `almagest.me` (free; `.ai` buyable) | fully clean via mix |
| ~~Morpheme~~ | "unit of meaning" — but **DROPPED**: near-minimal-pair with **morphine** (MOR-feem / MOR-feen, differ only m/n) → voice-confusion + drug connotation + SEO swamp | `morpheme` (free) | `getmorpheme` | `morpheme.me` (free) | killed — morphine homophone |
| **Striatum** | structure for **learning & habit** | `striatum` (free) | `getstriatum` | `striatum.me` (free) | fully clean via mix |
| **Stet** | proofreader's "let it stand" = **keep this** | `stet` (free) | `getstet` | `getstet.ai` (free) | clean; short/punchy |
| **Fascicle** | knowledge in **gathered sections** | `@fascicle`/`getfascicle` | `getfascicle` | `fascicle.ai` (free) | clean (npm scoped) |
| **Sulcus** | a **groove of the brain** | `@sulcus`/`getsulcus` | `getsulcus` | `sulcus.me` (free) | clean (npm scoped) |
| **Sextant** | navigate your knowledge | `@sextant`/`getsextant` | `getsextant` | `usesextant.com`+`.ai` (free) | prefix route |
| **Dictum** | "a thing formally said" | `@dictum`/`getdictum` | `getdictum` | `getdictum.ai` (free) | prefix route |
| **Kovar** | sealing-alloy / smith | `kovar` (free) | `getkovar` | `getkovar.com` (free; `.me`/`.ai` taken) | prefix route (domain) |

**Read:** the association-clean set — **Stet, Striatum, Almagest** (Fornix DROPPED for
fornication; Morpheme DROPPED for the morphine near-homophone) — assemble with
minimal prefixing (bare npm + bare `X.me` + `getX` GitHub), so they're effectively
**fully ownable today** despite the bare GitHub org being taken. **Stet** is the
front-runner: one syllable, spells itself from hearing (the failure mode that sank
Fascicle/Morpheme), no bad association, `stet` npm free + `getstet.ai` + `getstet`
gh. Prefix does NOT rescue killed names (live competitor persists). Remaining caveats:
Almagest erudite; Striatum/Sulcus anatomical-dry.
NB: association/homophone screen is now a mandatory gate — two "clean" top picks
(Fornix, Morpheme) died on it late. Survivors above re-checked for drug/vulgar/
homophone landmines.

## §27 — Shortlist K (creative round: TLD-hacks + fresh evocative · 2026-07-20)

Brief: 20, creative, fresh evocative meaning, combinations with TLDs/prefixes/
suffixes. Big unlock = **domain-hacks where the TLD completes the word** (precedent:
`hypothes.is` is a live annotation product). Legal-TLD notes matter for an EU
registrant: `.re`(Réunion)/`.it`(Italy) need EEA/EU residency (**qualifies**);
`.im`/`.se`/`.st`/`.io`/`.am` are **open**; `.us` needs a **US nexus**, `.om`(Oman)/
`.my`(Malaysia) are **restricted** (flagged). Association/spell screen applied.

### Shortlist K — TLD-completion hacks
| # | Domain | Spells | Meaning / fit | Availability | Caveat |
|---|--------|--------|---------------|--------------|--------|
| 1 | **lo.re** | LORE | accumulated knowledge passed down — dead-on for a knowledge base | **RDAP-confirmed FREE** | `.re` needs EEA (qualifies) — the standout |
| 2 | **verbat.im** | VERBATIM | word-for-word = what voice dictation captures | free (registrar-verify) | `.im` open; voice-first fit |
| 3 | **peru.se** | PERUSE | to read attentively | free (registrar-verify) | `.se` open |
| 4 | **dige.st** | DIGEST | your daily digest / resurfacing | free (registrar-verify) | `.st` open |
| 5 | **summ.it** | SUMMIT | the peak / overview of what you know | free (registrar-verify) | `.it` EU-residency (qualifies) |
| 6 | **fol.io** | FOLIO | a leaf / page of the book | free (registrar-verify) | `.io` open |
| 7 | **co.re** | CORE | your core | free (registrar-verify) | `.re` EEA (qualifies) |
| 8 | **hab.it** | HABIT | the daily practice | free (registrar-verify) | `.it` EU; habit-app-crowded |
| 9 | **corp.us** | CORPUS | a body of text/knowledge | free (registrar-verify) | ⚠ `.us` needs US nexus; "corpse" adjacency |
| 10 | **anato.my** | ANATOMY | the anatomy of your mind | free (registrar-verify) | ⚠ `.my` may need local presence |

### Shortlist K — evocative concepts (fresh territory)
| # | Name | Concept | Domain | Caveat |
|---|------|---------|--------|--------|
| 11 | **commonplace** | the **commonplace book** — the historical term for a personal knowledge collection | `commonplace.me` **free** | also means "mundane" (mild) |
| 12 | **vade** | *vade mecum* = "go with me" — a companion handbook | `vade.me` **free** ("vade me") | obscure Latin |
| 13 | **acumen** | sharpness of mind / insight | `acumen.me` **free** | — |
| 14 | **familiar** | a witch's **companion** / an AI familiar | `familiar.ai` held-dark (approach owner) | common word |
| 15 | **daimon** | Socrates' guiding spirit + Unix **daemon** | `daimon.ai` held-dark | ⚠ "demon" association |
| 16 | **zettel** | *Zettelkasten* slip-note — the PKM method | `zettel.ai` held-dark | ⚠ foreign/obscure/spell |
| 17 | **sibyl** | an **oracle** you consult | `sibyl.me` taken → `sibyl.ai`? verify | "Sybil" homophone |

### Shortlist K — buyable evocative concepts (for-sale, clean namesakes)
| # | Name | Concept | Domain (for-sale) | Caveat |
|---|------|---------|-------------------|--------|
| 18 | **athanor** | the alchemist's **ever-burning furnace** — an always-on inner fire | `athanor.io` (Afternic) | erudite; 3 syllables |
| 19 | **amphora** | the ancient **vessel** that carries precious goods | `amphora.ai` (Atom) | — (voice-clean) |
| 20 | **factotum** | a trusted **do-everything** attendant = exactly what an assistant is | `factotum.io` (GoDaddy) | "fact" onset is a bonus |

**Read — cleanest picks (open/buyable + good meaning + clean association):** **lo.re**
(the standout — RDAP-confirmed free, iconic word), **verbat.im** (voice-first),
**commonplace.me** (the literal PKM term), **dige.st**, **peru.se**, **acumen.me**;
of the buyable evocatives, **amphora** / **factotum** / **athanor** (all for-sale,
clean namesakes, voice-safe). Bench (buyable, clean, but long/flagged):
quintessence.ai, sagacity.ai, reliquary.ai. Killed — live same-category or occupied:
**bra.in** (→ TheBrain, live PKM), **hearth** (Hearth AI — live "second brain for
relationships," direct), lantern/taper/muse/augur/sherpa/wit/elixir/ember/crucible/
alembic/inkling (live products), lodestar.ai (gambling spam), op.us (Opus = Anthropic
model + `.us` nexus). Association-benched: nous ("noose"/Nous Research), amanuensis
(unspellable), daimon (→ demon), zettel (foreign/obscure), sibyl (Sybil spell-split).
Same Appendix D checklist; TLD-hacks need a registrar-verify (RDAP can't see
premium/reserved status on ccTLDs).

## §28 — "Familiar" concept: exhaustive free-domain dive (2026-07-20)

Concept the user liked: an AI **familiar** — a companion/guardian spirit that knows
you. Swept the word itself across ~18 TLDs + the whole folklore-companion synonym
field (guardian-spirit, witch's-familiar, Norse memory-raven, created servitor) on
`.ai`/`.me`/`.io`. **Finding: the concept is popular → every strong spellable word is
taken.** Gone on the premium TLDs: familiar, daemon, daimon, numen, numina, wisp,
muse, oracle, sibyl, muninn, huginn, servitor, grimoire, tulpa, egregore, and
**famulus** (the literal Latin root of "familiar": *famulus* → *familiaris* →
familiar). Method note: rdap.org gives false "free" for `.io` (familiar.io reads 404
there but is actually for-sale on Atom) — used Identity Digital RDAP for the
authoritative `.io`/`.me` check.

### Genuinely FREE (registrable now) — ranked
| # | Domain | Meaning | Spell / caveat |
|---|--------|---------|----------------|
| 1 | **eudaemon.me** | a **good / benevolent spirit** (eu- + daemon) — the "good familiar," and it *fixes the demon problem* | you-DEE-mon, moderate; sophisticated |
| 2 | **pooka.io** | a shapeshifting **companion fae** (Irish *púca*) | short, playful; `.io` reputable; only common-ish word free on `.io` |
| 3 | **familiaris.me** | the literal **Latin root of "familiar"** (of the household) | authentic but long (fa-mil-ee-AH-ris) |
| 4 | **munr.me** | Old Norse **"mind / memory"** — the root of Muninn (Odin's memory-raven) | on-brand but obscure spelling |
| 5 | **emissary.me** | an **agent sent to act on your behalf** | spellable, clean; less magical |
| 6 | **sylphid.ai** | a small **air-spirit** — free on the premium `.ai`! | obscure/diminutive |
| 7 | **eudaemon.ai**? no → **agathodaemon.me/.ai** | Greek **"good spirit"** (free on both) | very long |
| 8 | **domovoi.me** | Slavic **house-guardian spirit** | foreign, spell-hard |
| 9 | **votary.me** | a **devoted attendant** | obscure word |
| 10 | **famular** (`.me`/`.ai`/`.io` all free) | coinage ≈ "familiar" | ⚠ reads as a *misspelling* of familiar |

### Near-misses — buyable premium (NOT free), if willing to pay
- **familiar.io** — for-sale on Atom (the exact word, reputable TLD).
- **daemon.ai / daimon.ai** — parked/held (best concept: guiding-spirit + Unix daemon; ⚠ "demon").
- **amphora.ai / factotum.io / athanor.io** — for-sale (companion/vessel, from §27).

**Recommendation:** for a *free* domain that keeps the familiar/companion soul,
**eudaemon.me** is the pick — a benevolent spirit, sophisticated, and it sidesteps the
"demon" echo that dogs daemon/daimon. **pooka.io** is the freest *reputable-TLD*
option if you want playful over solemn. If you'll pay, **familiar.io** (the exact
word) or **daemon.ai** are the real prizes. Association-clean; all `.me`/`.ai`
verified via authoritative RDAP.

## §29 — Full check: pooka.io (2026-07-20)

Verdict: **AVOID (free domain, contested name).** `pooka.io` is genuinely
registrable, but "Pooka" is saturated in the AI-assistant space and carries a real
"poo" problem. The free domain is a mirage.

**Availability** — `pooka.io` free (404 authoritative + ENOTFOUND live = truly
unregistered; 5-letter `.io`, standard reg, ~$40–76/yr, not premium). But `.com`
dead-parked, and **`.ai`/`.co`/`.app`/`.me` all taken by other Pookas**. npm `pooka`
+ GitHub `pooka` taken → `@pooka`/`getpooka` variant.

**Namesakes — the killer (multiple live, same category)** (codex):
- **pooka.ai** = a live **AI-assistant marketplace** — direct hit.
- **pooka.co** = "Pooka AI for WordPress" (Pooka & Co) — live AI product.
- **pooka.omnigsoft.com** = OmniG's **Pooka SDK** (dev tool); **pooka.app** = Pooka TCG app.
- **poka.io** = established **Poka industrial-AI knowledge software** — near-homophone,
  same space; plus Pooca (self-care AI) and Puca (flashcards).
- Pop-culture: the invisible-rabbit pooka in *Harvey* (1950); Hulu's *Pooka!* (2018);
  Pooka Pages (active kids' content).

**Trademark** (codex) — no exact live POOKA wordmark in software cls 9/42 (legally
clear-ish), but crowded: POOKA jewelry (cls 14, live), Pooka Party LLC (EU 16/21/28,
live), and **PUKKA PAD** (Pukka Pads UK, stationery — category-adjacent). No famous
mark, but a busy name.

**Association / voice** (codex) — "poo" snicker-risk **MEDIUM** overall, **HIGH for
children**; spell-from-hearing **MEDIUM** (Puka/Puca/Pooca/Pookah/Pukka/**Poka**), and
"Poka" is a real competitor → confusion. Pukka (British "genuine") adjacency is mild.

**Recommendation — pass.** Even though `pooka.io` is free, the name already hosts a
live AI-assistant marketplace (pooka.ai), an AI WordPress plugin (pooka.co), a dev
SDK, and a near-homophone knowledge-software company (poka.io) — the exact space —
plus the poo association. For the familiar/companion soul without the crowding,
**eudaemon.me** (a *good* spirit) is the cleaner free pick.

## §26 — Full check: Fascicle (2026-07-20)

Verdict: **RISKY** — appealing meaning + free `.ai`/`.me`, but **two live products
literally named "Fascicle"** in adjacent spaces, plus minor association/spelling
friction. Usable with a scoped/prefixed identity, but more crowded than it first
looked (arguably riskier than past.me).

**Meaning / etymology** — Latin *fasciculus* = "small bundle" (dim. of *fascis*).
Two live senses: (a) publishing = one installment/section of a work issued in parts;
(b) anatomy/botany = a bundle of nerve/muscle fibers or a cluster of leaves. On-brand
read: "your knowledge in gathered sections" / a bundle of linked notes. Genuinely
apt.

**Namesakes — the problem (two live, both adjacent):**
1. **npm `fascicle` (bare)** = Rob McLarty's *"composable TypeScript toolkit for
   agentic workflows,"* active at v0.9.8, Apache-2.0, <https://github.com/robmclarty/fascicle>.
   Same technical space (AI agents) **on the registry we'd publish to** → forces a
   `@fascicle` scope or `getfascicle`, and a dev-facing name clash.
2. **fascicle.app** = live *"Fascicle — the research record designed around how
   wet-lab work actually happens; mobile-first capture, desktop analysis, exports."*
   An electronic-lab-notebook / research-capture SaaS — adjacent category (structured
   capture), different vertical (lab science). Holds `fascicle.app` (+ `.com` = SEO
   junk).

**Domains** — FREE: `fascicle.ai`, `.me`, `.io`, `.co`, `.xyz`, `.dev` (plenty of
options). Taken: `.com` (essaypro SEO redirect), `.app` (the ELN above).

**Namespace** — npm bare taken (agentic toolkit) → `@fascicle` scope / `getfascicle`
(free). GitHub bare taken → `getfascicle` / `usefascicle` / `fascicle-hq` / `fascicleai`
(all free).

**Association risk** — LOW–MEDIUM. "Fascicle" and "fascism/fascist" share the Latin
*fascis* (bundle) root, but spoken risk is low (FAS-ih-kul, soft-s, vs FASH-ist,
"sh") and the link is etymological trivia most people don't know; the shared visual
"fasci-" onset is a minor written flag. Weaker than the Fornix/fornication problem.

**Voice / spelling** — FAS-ih-kul; moderate spell-from-hearing (misheard "facicle /
fassicle / fascical"); mild friction for a voice-first product.

**Trademark** (codex, 2026-07-20) — **no LIVE registered FASCICLE wordmark** in USPTO
cls 9/42 or EUIPO; it's a descriptive/suggestive dictionary word → **weak
protectability** either way. No legal blocker.

**More namesakes** (codex) — beyond the npm toolkit + `fascicle.app` ELN: **Fascicle
Technologies Inc.** (<https://fascicle.ca>, a Canadian software/app consultancy) and
a **PyPI `fascicle`** (web-novel archiver). The npm toolkit is real+active but solo
(companion repo `robmclarty/weft` visualises "Fascicle composition trees," 1 star,
rapid releases v0.8→0.9 in weeks) — early-stage, not established, but a material
same-category collision. No exact-name AI/PKM/notes *app* found.

**Voice/spelling** (codex) — **WEAK**: hearing FAS-ih-kul does not reliably reveal
the spelling; likely errors `fasicle / fascical / fascicel / fascicule / fascikul`.
Real friction for a **voice-first** product. Association risk **MEDIUM**.

**Recommendation — RISKY, leaning pass.** No trademark blocker and `fascicle.ai` +
`@fascicle` are obtainable, but the name is **crowded in software** (agentic npm
toolkit + ELN app + Canadian consultancy + PyPI) and, decisively for a *voice-first*
product, **spells poorly from hearing**. Lovely meaning, but the spelling + crowding
outweigh it. For an uncontested, voice-clean run → Almagest / Morpheme / Striatum /
Stet (§25) carry no live same-category namesake and spell cleanly.

## §31 — Shortlist L (pop-culture references · 2026-07-20)

Brief: 20 names from fiction / myth / MacGuffins / places tied (even by anecdote) to
memory, knowledge, or a second brain. Myth + fandom names are heavily startup-claimed,
so every `.ai` was live-probed to split live-product (kill) from parked/buyable/dark.
Association + spell screen applied.

### Characters / minds
| # | Name | Anecdote | Domain |
|---|------|----------|--------|
| 1 | **Mentat** | *Dune* — humans trained as living computers (the Mentat mantra) | mentat.ai dark |
| 2 | **Multivac** | Asimov's AI that answers any question from all human knowledge ("The Last Question") | multivac.ai **for-sale**; ⚠ Multivac packaging co (.com, diff sector) |
| 3 | **Nestor** | Homer's wise old counselor everyone turns to — long memory, sage advice | nestor.ai **for-sale**; ⚠ small HR startup |
| 4 | **Mnemonist** | Luria's *Mind of a Mnemonist* — the man who could not forget | **.ai + .me free** |
| 5 | **Memorious** | Borges' *Funes the Memorious* — perfect recall, the tale this product answers | memorious.me free |

### Mythic figures of memory / writing
| 6 | **Seshat** ⭐ | Egyptian goddess of writing, records & **libraries** | seshat.ai **for-sale** (clean) |
| 7 | **Mimir** ⭐ | Norse — the wise head Odin keeps and **consults by speaking** (voice-companion fit) | mimir.ai parked; ⚠ Mimir Classroom |
| 8 | **Urania** | the Muse who lifts the mind to higher knowledge | urania.ai **for-sale** |
| 9 | **Thoth** | Egyptian god who invented writing; scribe of the gods | thoth.ai parked |

### MacGuffins / knowledge-objects
| 10 | **Transclude** | Ted Nelson's **transclusion** — the block-embed behind Roam/Obsidian | **.ai + .me free** |
| 11 | **Stonetape** | BBC's *Stone Tape* — stone that records & replays memory | **.ai + .me free** |
| 12 | **Pensieve** | *HP* — the basin you pour memories into to review from outside | pensieve.ai dark; ⚠ WB TM |
| 13 | **Metis** | Titaness of **wise counsel**, Athena's mother (swallowed to keep her wisdom) | parked; ⚠ Metis crypto L2 |

### Locations / institutions of knowledge
| 14 | **Armarium** ⭐ | the medieval monastery's **book-cupboard** = its entire library | **.ai + .me free** |
| 15 | **Geniza** | the Cairo Geniza — the sacred **never-delete archive** | geniza.me free (respect origin) |
| 16 | **Mundaneum** | Otlet's 1910 "paper Google," 12M index cards — the PKM ancestor | mundaneum.me free; ⚠ museum + "mundane" onset |
| 17 | **Wunderkammer** | Renaissance cabinet of curiosities = a personal knowledge-universe | wunderkammer.ai free; ⚠ German spell tax |
| 18 | **Nomai** | *Outer Wilds* — a vanished civ's knowledge-network + ship-log = a second brain across time | nomai.me free |
| 19 | **Lspace** | Discworld — **L-space**, where all libraries connect | .ai + .me free; ⚠ Pratchett estate |
| 20 | **Maester** | *GoT* — the castle loremaster who keeps knowledge (a link forged per field) | maester.me free; ⚠ "master" homophone + GRRM |

**Cleanest of the round** (open/buyable + clean TM + decent spell + strong anecdote):
**Armarium** & **Seshat** (both dead-on for a knowledge base), then **Multivac**,
**Mimir** (best voice fit), **Nestor**, **Mnemonist**, **Transclude**, **Stonetape**,
**Geniza**, **Nomai**. **Kills** (live product / IP): **Memex** (live AI-coding tool +
WorldBrain Memex PKM extension), **Mycroft** (Mycroft AI — open-source *voice
assistant*, our exact category), Xanadu (Xanadu Quantum), Prospero (stock app),
Muninn (security AI), Virgil/Delphi/Kvasir/Enki/Ogma (AI cos), Palantír/Cortana/
Athena/Merlin/Holocron/TARDIS/Ravenclaw (IP), Pythia (EleutherAI LLM suite), Lacuna
(*Eternal Sunshine* — the memory-*deletion* company, a joke not a brand). Same
Appendix D checklist; buyable/dark domains need price + owner check.

## §32 — Shortlist M (pop-culture, round 2: games + fantasy-lit + world myth · 2026-07-21)

Fresh franchises, deduped against L. Every `.ai` live-probed to split live-product
(kill) from parked/buyable/dark. Association + spell screened.

### Register-now-free (both `.ai` + `.me`)
| # | Name | Source | Anecdote | Caveat |
|---|------|--------|----------|--------|
| 1 | **Oannes** ⭐ | Mesopotamian | the fish-sage who rose from the sea to **teach humanity writing & the sciences** | both free, zero namesake; oh-AH-nays |
| 2 | **Cryptarch** | Destiny | the order that **decodes encrypted engrams into usable knowledge** | both free; mild "crypto" vibe |
| 3 | **Palanaeum** | Sanderson, *Way of Kings* | the mountain-library where **ardents research for you on request** | both free; spell-hard (pal-ah-NAY-um) |

### Buyable / parked-dark (no live product)
| # | Name | Source | Anecdote | Caveat |
|---|------|--------|----------|--------|
| 4 | **Piranesi** ⭐ | Susanna Clarke | the House is a memory-palace; the narrator **survives via his meticulously indexed journals** | real 18th-C etcher = strong TM shield; buyable |
| 5 | **Compendium** ⭐ | Zelda BotW | photograph anything → auto-catalogued with lore; and the word **literally means a collection of knowledge** | fully generic = TM-safe; everyone spells it |
| 6 | **Waystone** | Kingkiller | notes that **mark safe paths for your future self** | generic compound = TM-safe; perfect spell |
| 7 | **Lucien** | Sandman | the librarian who **catalogs every book never written** — your unwritten thoughts, shelved | common French name shields the DC mark |
| 8 | **Remem** | Ted Chiang | the lifelog assistant whose story **IS this product's ethical ancestor** | reh-MEM; unregistered story-term |
| 9 | **Monomon** | Hollow Knight | the Teacher who **preserves the kingdom's knowledge in an Archive** | .ai free; slightly cute |
| 10 | **Orac** | Blake's 7 | the computer that **retrieves knowledge from any other computer** | for-sale; Orac Decor (mouldings, non-tech) |
| 11 | **Ioun** | Vance / D&D | the stone that **orbits your head granting knowledge** — ambient companion | .me free; ⚠ "ion" homophone |
| 12 | **Roke** | Earthsea | the Isle of the Wise, where **a thing's true name is power over it** | buyable; "rock" mishear |
| 13 | **Auryn** | Neverending Story | the emblem + **the book that reads its reader back** | buyable; Auryn/Orin trap |
| 14 | **Ofnir** | Elden Ring / Odin | the all-knowing counselor (Odin epithet = **public-domain shield**) | .me free; obscure |
| 15 | **Breq** | Ancillary Justice | a warship-AI **carrying centuries of memory** in one body | .me free; coined/ownable |
| 16 | **Adapa** | Mesopotamian | the **first of the sages**, given understanding by Ea | parked; clean spell |
| 17 | **Fintan** | Irish myth | Fintan the Wise, who **holds all of Ireland's memory & history** | parked; clean |
| 18 | **Shamash** | Mesopotamian | the sun god who **sees and knows everything** | parked |
| 19 | **Tenjin** | Japanese | kami of **scholarship**; students pray to him for knowledge | parked; ⚠ Tenjin.io analytics |
| 20 | **Dagda** | Irish myth | the all-father whose **cauldron & harp order the world** | for-sale |

**Cleanest of the round:** **Oannes** (fully free, zero namesake), **Compendium** (a
real word = "a collection of knowledge," TM-safe, Zelda anecdote), **Piranesi** (best
pure name + etcher TM-shield + the indexed-journals-as-survival fit), then **Cryptarch**,
**Waystone**, **Lucien**, **Remem**, **Orac**, **Monomon**. **Kills** (live product):
Apocrypha (phishing-sim + "doubtful authenticity" wrong meaning), Aletheia (agency),
Anathem, Erasmus (knowledge-AI platform), Nisaba (edtech AI), Apkallu.ai (traffic-sim
— but apkallu.me free), Itzamna, Zahir, Primer. **Pre-killed on TM:** Sheikah/Fi/Ghost
(Nintendo/Ghost.org), Thought-Cabinet (ZA/UM), Myst (Cyan), Truename (Identity
Digital's product), Cangjie (input-method + unspellable). Marketing anecdote-bank
(names unusable, stories gold): Planescape's memory-tattoos, Zafón's Cemetery of
Forgotten Books (= resurfacing), Discworld Death's self-writing autobiographies (=
auto-capture), Fahrenheit 451's book-people (= living backups), 1984's memory hole
(= the anti-product). Same Appendix D checklist.

## §33 — Full check: Compendium & Cryptarch (2026-07-21)

Both **avoid** — opposite failure modes.

### Compendium — PASS (perfect meaning, un-ownable + crowded)
- **Availability weak:** `.com/.ai/.io/.me/.dev` all taken (common word); only `.co`
  free. npm + GitHub `compendium` taken → `getcompendium` — **but `getcompendium.app`
  is a live RAG/AI enterprise-data product**, so the natural variant path is occupied.
- **Namesakes crowded** (codex): Open University's **CompendiumNG** (open-source
  knowledge/argument-mapping tool — PKM-adjacent), Oracle's Compendium (discontinued),
  a live RAG/AI product (getcompendium.app), a Compendium MTG companion app.
- **Trademark:** live COMPENDIUM reg (No. 5,830,564, cls 9 lighting-control sw; + a
  blank-journals mark) — not PKM, but "collection of knowledge" is **descriptive/weak**
  → you can't really own it for a knowledge product.
- **Association:** flawless category read, but 4 syllables, institutional tone, weak
  ownability, expensive/noisy SEO.
- **Verdict:** strong *descriptor*, weak *brand*. The thing that makes it fit (it
  literally means "a knowledge collection") is exactly why it's un-ownable. Reject.

### Cryptarch — PASS (clean domains, but derivative + crypto-signal)
- **Availability good:** `.ai`+`.me`+`.dev`+`.co` free; `.com` buyable (HugeDomains).
  npm + GitHub `cryptarch` taken → `getcryptarch`.
- **Trademark:** no exact CRYPTARCH registration (knockout-clear), and Bungie didn't
  register the word — **but it's Bungie's coined Destiny faction name**, and Bungie
  reserves rights in Destiny content → derivative/IP-shadow risk. Namesakes: a live
  Destiny Chrome extension + cryptarch.guide (fandom); **KRYPTARCH** = a live HR app
  (near-homophone).
- **Association (the killer):** "**crypt-**" strongly cues **crypto/blockchain** (wrong
  signal for a knowledge app + SEO swamp) and secondarily tomb/gothic. The Destiny
  "decoder-of-engrams" metaphor is superb but **feels derivative**. Spell-from-hearing
  mediocre (Cryptarch/Cryptark/Cryptarc/Kryptarch).
- **Verdict:** memorable, cleanest domains of the pair — but Destiny-dependence + the
  crypto read outweigh the fit. Avoid.

**Net:** neither clears. For a name that keeps a strong knowledge metaphor *and* is
ownable + non-derivative + voice-clean, the cleaner pop-culture picks are **Piranesi**
(real-etcher TM shield; "survives via his index") and **Oannes** (fully free), or the
campaign's non-pop leads **lo.re** / **Almagest** / **Stet**.

## §34 — Shortlist N (pop-culture, round 3: game/TV AIs + world myth of stories · 2026-07-21)

Fresh franchises + non-Western myth, deduped against L/M. Every `.ai` live-probed.
Association + spell + cultural-sensitivity screened.

### Games / TV — AIs & knowledge-devices
| # | Name | Source | Anecdote | Domain / flag |
|---|------|--------|----------|---------------|
| 1 | **Lifestream** ⭐ | Gelernter (Yale) + FF7 | Gelernter's *real* research — your docs as a chronological stream, the academic ancestor of every feed; an honest origin story | both parked-dark; TM-safe compound |
| 2 | **Simaris** | Warframe | the archivist-AI whose Sanctuary asks you to **scan everything to "complete the record"** | **.ai + .me free** |
| 3 | **Ordis** | Warframe | your ship's loyal companion AI who **manages your archive & speaks in your ear** | ordis.me free; .ai buyable |
| 4 | **Radiant** | Foundation (Prime Radiant) | the handheld projecting the whole model, **annotated by generations** | parked-dark; generic = TM-safe |
| 5 | **Milton** | The Talos Principle | the Library Assistant AI that **argues with you about what knowledge is for** (+ *Paradise Lost* poet) | parked-dark |
| 6 | **Alvis** | Xenoblade + Norse *Alvíss* | the world's ontological computer; in the Eddas the dwarf "All-Wise" who **answered every question** (myth = public-domain shield) | parked-dark |
| 7 | **Khala** | StarCraft | the psychic communion binding **all protoss memory into one shared archive** | khala.me free; ⚠ Arabic "aunt" (benign) |
| 8 | **Vigil** | Mass Effect | the archive that **waited 50,000 years to warn the next civilization** — notes that outlive their author | .ai parked/buyable; funeral-watch connotation |

### World myth of stories / knowledge / memory
| # | Name | Source | Anecdote | Domain / flag |
|---|------|--------|----------|---------------|
| 9 | **Anansi** ⭐ | West African | the spider who **bought & owns all the world's stories** — keeper of every narrative | anansi.ai dark; clean; folklore (lower sensitivity) |
| 10 | **Sankofa** ⭐ | Akan (Ghana) | "go back and get it" — the bird that **retrieves knowledge from your past** (recall, exactly) | sankofa.ai **for-sale**; a proverb/symbol |
| 11 | **Tane** | Māori | ascended to the highest heaven for the **three baskets of all knowledge** | tane.ai **for-sale**; spell "TAH-neh" moderate |
| 12 | **Simurgh** | Persian | the ancient **all-knowing bird** who has seen the world reborn thrice | parked; ⚠ Simurgh/Simorgh spelling |
| 13 | **Bragi** | Norse | god of **poetry & eloquence** — the bardic voice of the gods | parked; ⚠ Bragi (defunct earbuds) |
| 14 | **Ceridwen** | Welsh | her cauldron: **three drops grant all knowledge** | ceridwen.me free; long |
| 15 | **Griot** | West African | the hereditary **keeper of oral history** — a living library | griot.ai for-sale; ⚠ silent-t (GREE-oh) |
| 16 | **Tlön** | Borges | the invented encyclopedia-world that **overwrites reality** | tlon.ai free; ⚠ Tlon Corp (Urbit) + spell |
| 17 | **Cephalon** | Warframe + biology | the archivist-AI class | cephalon.me free; ⚠ live Cephalon AI + pharma |
| 18 | **Eshu** | Yoruba | messenger-god of **language & interpretation** (voice fit) | parked; ⚠ active Orisha — cultural-sensitivity flag |
| 19 | **Legba** | Yoruba/Vodou | the **gatekeeper & divine interpreter**, master of languages | parked; ⚠ active Lwa — sensitivity flag |
| 20 | **Orunmila** | Yoruba | god of **wisdom & divination**, knows every destiny | orunmila.me free; ⚠ active Orisha + long |

**Cleanest of the round:** **Lifestream** (the real-research origin story is a marketing
gift), **Anansi** (owner of all stories, clean & dark), **Sankofa** (retrieve-from-past =
recall, buyable), then **Simaris**, **Ordis**, **Radiant**, **Milton**, **Alvis**, **Tane**.
**Cultural note:** Eshu/Legba/Orunmila are *active-worship* Yoruba/Vodou deities —
use would risk offense; Anansi (folklore) and Sankofa (a proverb/adinkra symbol) are
lower-sensitivity. **Kills:** Awen (live AI creative platform), Preserver (live capture
app — in-category), Norn/Runo/Narada (live AI cos), Animus (Ubisoft + "hostility"
meaning), SHODAN (villain), GAIA/Apollo/Focus (taken), Lumon/Rehoboam (HBO). Cross-note:
ST:TNG's **Lore** = Data's evil twin — mild flag on §27's lo.re (harmless; the word
dominates). Same Appendix D checklist.

## §35 — Full check: Anansi + cultural-appropriation read (2026-07-21)

Verdict: **PASS — but on commercial crowding, not culture.** The cultural use is a
defensible gray area; the name is simply already saturated in AI/software, including a
near-exact same-category product.

### Cultural question (the honest read)
- **Status:** Anansi is primarily **folklore** — an Akan/Asante (Ghana) trickster and
  culture-hero (spider, owner of all stories), **not an organized-worship deity** like
  the Yoruba Orisha (Eshu/Legba/Orunmila). "Merely fictional" is too strong ("god"
  appears in some Ghanaian/scholarly descriptions), but he's encountered through living
  folklore. Enslaved Africans carried the tales to the Caribbean (Anancy) and US (Aunt
  Nancy); outwitting stronger foes made him a **resistance/survival symbol**.
- **Appropriation:** no major documented backlash against *the name alone*; widely
  embraced adaptations exist (House of Anansi Press, Marvel, games, Gaiman's Mr Nancy).
  But Gaiman himself later said he wouldn't write *Anansi Boys* today without stronger
  Black creative control — a real caution signal. Diaspora views are **not uniform**.
- **Net cultural:** gray-but-generally-fine for a European founder **if** the Akan/
  Caribbean origin + resistance history are credited and diaspora voices inform the
  branding; **low-to-moderate** reputational tail-risk (some will read "Western AI co
  borrows African heritage for cachet"). A judgment call, not a clear taboo.

### The actual dealbreaker — commercial crowding
- **Namespace saturated:** `.com/.ai/.io/.me/.app/.dev` all taken (only `.co` free);
  npm `anansi` (kael) + GitHub `anansi`/@anansi React tooling (ntucker) taken.
- **Direct same-category namesake:** **anansimemory.com** = "Anansi, an MIT-licensed
  self-hosted **memory API for AI apps**" — almost the exact conceptual territory.
- **More AI namesakes:** anansihub.com (AI knowledge-lineage), ananse.ai (legal AI),
  anansicyber.com (security), Trinidad & Tobago's national AI assistant.
- **Trademark:** Seemee B.V. holds ANANSI (EU reg 018128825 cls 9/16/28/41; US app
  suspended) — media content, not SaaS; + House of Anansi Press (publisher since 1967,
  adjacent stories/knowledge goodwill).

**Recommendation:** pass. The crowding (esp. a live "memory API for AI" named Anansi)
kills it before the cultural question even gets to decide — and it's un-ownable
namespace-wise. If the *"owner of all stories"* metaphor is what appeals, **Sankofa**
(retrieve-from-your-past, buyable) or **Griot** (the living-library storykeeper) carry a
similar spirit with far less crowding — though the same "credit the origin" courtesy
applies.

## §36 — Full check: Sankofa + cultural read (2026-07-21)

Verdict: **PASS on both axes.** Correcting §35's suggestion — Sankofa is *not* the
cleaner alternative: it's both crowded (a direct PKM namesake) and *more* culturally
loaded than Anansi.

### Commercial (the hard kill)
- **Direct PKM collision:** **Vectara's open-source "Sankofa"** — a GenAI browser
  extension that **indexes the pages you visit and lets you chat/search over your
  personal history**: the exact "memory / second brain" territory.
  (<https://github.com/vectara/sankofa>)
- **More tech namesakes:** **Sankofa OS** (open-core platform, github `sankofa-hq`,
  npm `@sankofa`), SankofAI, Trybl's Sankofa AI. Plus Haile Gerima's celebrated 1993
  film + **Sankofa Video Books & Café** (US reg 7120315, cls 35).
- **Namespace:** `.com/.ai/.io/.me/.app/.dev` taken (only `.co` free); `sankofa.ai`
  for-sale; GitHub `sankofa` taken (npm bare free, but `@sankofa` taken). "Exceptionally
  bad for PKM" per codex.
- **Trademark:** pending SANKOFA (Sankofa AI Ventures LLC, cls 35/42, AI consulting,
  suspended); old cls-9 software reg died 2023; bookstore holds cls-35.

### Cultural (sharper than Anansi)
- **Meaning:** Akan adinkra symbol + proverb — "go back and get it," the bird facing
  backward while moving forward. A philosophical/visual symbol, **not a deity**.
- **Heritage loading:** heavily used in Pan-African / African-American **reclamation**
  contexts (NMAAHC, NPS tie it to slavery, family history, historical recovery). So a
  European commercially "taking" a symbol specifically about **recovering heritage
  stripped by slavery/colonialism** carries *sharper irony* than a generic myth name.
- **Net:** no well-documented Sankofa-specific appropriation backlash (Toronto's
  "Sankofa Square" pushback was about process/cost, not appropriation), and the maxim
  is widely shared — so not taboo, but **medium-high reputational risk** + high
  search-confusion risk. Criticism plausible, not certain.

**Recommendation — pass** (and my §35 pointer to it was wrong): Vectara's Sankofa is a
near-exact PKM competitor, and the heritage-reclamation loading raises the cultural
stakes above Anansi, not below. Both African story-keeper picks (Anansi, Sankofa) are
out. If the *"learn from / retrieve your past"* meaning is the draw without the
baggage, the cleaner leads remain **lo.re**, **Almagest**, **Stet** (§25/§27) or the
pedigree-rich **Lifestream** (§34).

## §37 — Shortlist O (pop-culture, round 4: games/music/film + Eastern memory-concepts · 2026-07-21)

Fresh veins, deduped against L/M/N. Every `.ai` live-probed. **Diminishing returns
flagged:** nine rounds in, the strongest on-concept picks are increasingly taken/live/
premium (smriti.ai = $50k; oblique/maat/manas/shruti = live AI). The 20 below still
hold up; the leads are the first ~8.

### Games / music / film
| # | Name | Source | Anecdote | Domain / flag |
|---|------|--------|----------|---------------|
| 1 | **Pentiment** ⭐ | art history / Obsidian game | an *earlier painting showing through later layers* — old notes ghosting through new thinking; a **pen** at its root | **.ai + .me free**; Obsidian *game* title (≠ Obsidian PKM app) |
| 2 | **Scriptorium** ⭐ | monastic history | the room where knowledge was **copied, preserved & passed forward** | .ai parked-dark; real word, everyone spells |
| 3 | **Savepoint** | gaming + SQL | where progress persists before a risk — and a literal **SQL keyword** = TM-safe | .ai parked-dark; perfect spell |
| 4 | **Setec** | *Sneakers* | SETEC ASTRONOMY = "too many secrets" — the box that reads everything | buyable; crisp |
| 5 | **Scenius** | Brian Eno | "the genius of the scene" — **your notes networked = a scenius of one** | .ai for-sale; c/s spell trap |
| 6 | **Wax** | Plato + Edison | Plato's **wax-tablet of memory** + wax cylinders (first voice recordings) + "waxing poetic" | .ai parked-dark, premium |
| 7 | **Caretaker** | *Everywhere at the End of Time* | the album of memory dissolving — **this product fights exactly that** | parked-dark; somber |
| 8 | **Musubi** | *Your Name* / Shinto | braided cords binding time & memory — **knot-as-knowledge-graph** | parked-dark; ⚠ Spam-musubi |
| 9 | **Obradinn** | Obra Dinn | reconstruct every fate **from fragments** | **.ai + .me free** |
| 10 | **Junimo** | Stardew Valley | the helper-spirits who quietly **restore what's fallen into disrepair** | **.ai + .me free**; whimsical |
| 11 | **Navidson** | House of Leaves | the *Navidson Record* — the impossible house documented in footnotes-within-footnotes | **.ai + .me free**; obscure |
| 12 | **Vishanti** | Dr. Strange | the *Book of the Vishanti* — the tome of all benevolent knowledge | vishanti.me free |

### Eastern memory-concepts (doctrinal terms — "zen/karma"-level, not deities)
| # | Name | Tradition | Anecdote | Domain / flag |
|---|------|-----------|----------|---------------|
| 13 | **Medha** ⭐ | Hindu | the personification of **intellect & retentive memory** | parked; clean, cheap |
| 14 | **Bija** ⭐ | Buddhist | the **"seed"** — karmic seeds of memory in the storehouse | parked; short/clean |
| 15 | **Anamnesis** ⭐ | Greek (Plato) | **all learning is recollection** — knowledge *is* memory | parked; long + medical |
| 16 | **Alaya** | Buddhist | the **"storehouse consciousness"** holding all memory-seeds — a literal second brain | for-sale; ⚠ Alaya AI |
| 17 | **Bodhi** | Buddhist | **awakening** — the Bodhi tree of knowledge | parked; ⚠ Bodhi Linux |
| 18 | **Vidya** | Hindu | **knowledge / learning** itself | parked; common name |
| 19 | **Samskara** | Hindu/Buddhist | the **mental imprints** every experience leaves | parked; long |
| 20 | **Dharani** | Buddhist | a **mnemonic that holds & protects** teachings | for-sale; ⚠ Telangana land portal |

**Cleanest of the round:** **Pentiment** (both free, sophisticated, pen-root, "layers of
thought"), **Scriptorium** (the literal knowledge-work room), **Savepoint** (TM-safe +
techy), then **Medha**, **Bija**, **Anamnesis**, **Setec**, **Scenius**. **Cultural
note:** the Sanskrit/Pali terms are *doctrinal concepts* — like branding with "zen"/
"karma": rooted but widely used, far lower sensitivity than the African deities or
Sankofa's reclamation loading. Avoid **Sati** (widow-immolation) + worshipped deities
(Chitragupta/Saraswati). **Kills:** Quicksave (live read-later — in-category), Shruti
(live voice-AI), Oblique/Maat/Manas/Prajna/Sutra/Pramana (live AI). Same Appendix D
checklist.
