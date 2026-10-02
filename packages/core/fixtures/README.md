# Fixture corpus — `corpus/`

A self-contained, keyless test brain owned by **Odysseus**, on Ogygia after
ten years returning from Troy. Ancient problems, modern organisational tools:
raft plans, sail repairs, recovery notes and Calypso's star bearings live in
Markdown. The cast and canonical chronology match
[the UI fixture world](../../ui-kit/fixtures/README.md).

The [2026-09-30 corpus ruling](../../../docs/decisions/example-corpus.md)
requires this same world in CLI/MCP examples, docs, skills, onboarding,
renderer samples, Storybook, screenshots, measurement harnesses and public
website assets. These technical representations serve different purposes;
core runtime code does not depend on UI packages.

This compact corpus retains engineered retrieval and audit cases: exactly
one non-exempt orphan, two unresolved links, ambiguous basenames, fixed
staleness windows and intentional fact drift. The dated planning notes stop
at July 5, before the four-day raft build depicted as complete by the UI's
July 12 snapshot. An active document is maintained content, not a claim that
the raft project remains unfinished. The July 29 deadline is the end of the
seventeen-day passage, matching D19. The long bio deliberately says Troy fell
in 2015; the canonical FACTS value is 2016, and the fact-drift audit must catch
it. Do not treat negative cases as alternative canonical facts.

Index a temporary copy for integration, contract and retrieval tests. All
content is invented; the whole-tree leakage gate applies unchanged.

## A real keyless CLI walkthrough

From a repository checkout after `bun install`, copy the corpus rather than
writing test state into it. These commands use the real CLI and the existing
capture clock, which pins the demonstration to July 12, 2026. No provider key
is needed. The `jq` projections keep timing and score fields out of this
transcript; they do not change the CLI's JSON envelopes.

```sh
fixture_root="$(mktemp -d)"
cp -R packages/core/fixtures/corpus/. "$fixture_root/"
ln -s "$PWD/node_modules" "$fixture_root/node_modules"
export BRAIN_ROOT="$fixture_root" TZ=Etc/GMT-2
unset TYPESAFE_API_KEY GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY BRAIN_RERANK_MODE

bun --preload ./scripts/captures/clock.ts ./packages/core/src/cli/brain.ts \
  index --force --json | jq '{total, chunks, embeddings}'
bun --preload ./scripts/captures/clock.ts ./packages/core/src/cli/brain.ts \
  add "Tie me to the mast before the Sirens." --title "Sirens reminder" --json
bun --preload ./scripts/captures/clock.ts ./packages/core/src/cli/brain.ts \
  search Sirens --mode fts --json | jq '{paths: [.results[].path], warnings}'

rm -r "$fixture_root"
unset BRAIN_ROOT
```

The recorded run produced these three results, with empty stderr and exit
code zero for each CLI invocation:

```json
{"total":25,"chunks":25,"embeddings":0}
{"action":"created","path":"notes/sirens-reminder.md","title":"Sirens reminder","type":"note","indexed":true}
{"paths":["notes/sirens-reminder.md"],"warnings":[]}
```

## Reference date and the fixed "now"

**Every date in this corpus is pinned relative to the reference date
`2026-07-12`.** Staleness and index-lag are the only scenarios that depend on the
current time, and they are engineered against that date.

> **Test authors: inject a fixed `now = 2026-07-12`, never the wall clock.**
> If staleness is computed against the real date, the "fresh" fixtures drift into
> "stale" and the goldens rot. Whatever seam the auditor uses for the current time
> (clock injection / `now` parameter) must be set to `2026-07-12` in these tests.

## Config (`corpus/brain.config.ts`)

Layered over the four core built-in types (`identity`, `context`, `note`, `index`):

| Type | dir | match | staleDays | severity | flags |
|------|-----|-------|-----------|----------|-------|
| `health` | `health` | — | 60 | warning | |
| `project` | `projects/active` | `projects/` | 90 | warning | `appendMatch` |
| `study` | `studies` | — | — | — | |
| `journal` | `journal` | — | — | — | `orphanExempt` |

- **classifierHints** — `health`: `symptom, appointment, prescription, blood pressure`;
  `study`: `chapter, lecture, exercise, course`.
- **propagation** — source `me/basics/FACTS.md` → derivatives `me/basics/*.md`.
- **assetTitleRules** — `{ prefix: "projects/", label: "Build Photo" }`.
- **canonical** — defaults apply (`identity: me/identity.md`,
  `currentFocus: context/current-focus.md`); both files exist.
- **dirAnchors** — core default `["_index.md"]` only (no modules loaded), so a
  directory wiki-link resolves via `_index.md`, **not** `status.md`.

> The config imports `defineConfig` from `@schlessera/brain` — resolved via the
> workspace link (hoisted linker, see bunfig.toml). Tests normally load it via
> the same `loadUserConfig(root)` path the CLI uses.

## Scenario → fixture map

This is the contract: each scenario below is present at least once.

| Scenario | Fixture(s) | What to assert |
|----------|-----------|----------------|
| **Staleness (warning)** | `health/knee-injury.md` (updated 2026-04-20, 83 d) | `health` `staleDays:60` → warning at now=2026-07-12 |
| **Staleness (stale draft)** | `health/sleep-tracking.md` (`status: draft`, updated 2026-03-01, 133 d) | stale **and** draft; > 90 d |
| **Fresh (must NOT flag)** | `health/checkup-log.md` (2026-06-25), all active projects, `context/*` | inside their windows at now=2026-07-12 |
| **Propagation lag** | `me/basics/short-bio.md` (2026-05-01) vs source `FACTS.md` (2026-06-01) | derivative lags source → finding |
| **Propagation OK** | `me/basics/long-bio.md` (2026-06-10) vs `FACTS.md` (2026-06-01) | derivative newer than source → no finding |
| **Index lag** | `projects/active/raft/_index.md` (2026-06-15) vs sibling `status.md` (2026-06-30) | index lags a detail file by 15 d (> 7) |
| **Orphan (flagged)** | `notes/loose-idea.md` | non-exempt `note`, zero in/out links → orphan |
| **Orphan-exempt** | `journal/2026-06-15.md`, `journal/2026-07-01.md` | linkless but `journal` is `orphanExempt` → not flagged |
| **Classifier: health** | `health/checkup-log.md` (blood pressure, appointment, symptom, prescription) | `classify()` → `health` |
| **Classifier: study** | `studies/star-bearings.md`, `studies/navigation/overview.md` (course, lecture, chapter, exercise) | `classify()` → `study` |
| **Asset title (project photo)** | `projects/active/raft/photos/frame.png` | `assetTitleFor()` → `Build Photo: frame` |
| **Asset title (fallback)** | `me/avatar.png` → `me: avatar`; `studies/star-chart.pdf` → `studies: star-chart` | no rule → `<dir>: <name>` |
| **`match`-prefix type (dir ≠ dir)** | `projects/archive/one-old-build.md` | under `projects/archive/`, still `typeForPath → project` via `match:["projects/"]` |
| **`dir: null` type** | any `_index.md` (`index` type) | dir checks skipped; `orphanExempt` |
| **Archived status** | `projects/archive/one-old-build.md` (`status: archived`) | status vocabulary |
| **Inbox capture** | `notes/*` (`note` is `inbox: true`) | `inboxType() → note` |
| **appendMatch type** | `project` | `appendMatchTypes() → [project]` |
| **Canonical docs** | `me/identity.md`, `context/current-focus.md` | `canonicalPath("identity"/"currentFocus")` |

### Frontmatter edge cases

| Edge case | Fixture |
|-----------|---------|
| `aliases` array | `studies/star-bearings.md` (`["my bearings", "the Calypso guide", "the bearingbook"]`; the last appears nowhere else in the corpus) |
| `deadline` field | `projects/active/raft/status.md` (`2026-07-29`) |
| `next_review` field | `context/current-focus.md`, `context/reading-list.md` |
| Unicode title (emoji + umlauts) | `studies/navigation/star-catalog.md` (`🧭 Stern-Katalog — Nächtliche Übersicht`) |
| Minimal (only `type`/`title`/`created`/`updated`) | `notes/loose-idea.md` (also the orphan) |
| `[TODO: …]` marker | `notes/quick-note-water.md` |
| `[VERIFY: …]` marker | `notes/quick-note-eagle.md` |

### Wiki-link resolution matrix

Each resolver case is exercised by a real link in the corpus. `now`-independent.

| Case | Link (in file) | Resolves to |
|------|----------------|-------------|
| Qualified path | `[[projects/active/raft/plan]]` in `context/current-focus.md` | `projects/active/raft/plan.md` |
| Unique basename | `[[star-bearings]]` in `context/current-focus.md` (+ others) | `studies/star-bearings.md` |
| Ambiguous → same-dir sibling | `[[overview]]` in `projects/active/raft/_index.md` | `projects/active/raft/overview.md` (not `studies/navigation/overview.md`) |
| Unresolved | `[[does-not-exist]]` in `context/current-focus.md` & `notes/quick-note-eagle.md` | `null` |
| Alias | `[[star-bearings\|my bearings]]` in `studies/navigation/star-catalog.md` | `studies/star-bearings.md` (display "my bearings") |
| Directory link | `[[projects/active/raft/]]` in `context/current-focus.md` | `projects/active/raft/_index.md` (`_index.md` anchor) |

The two `overview.md` files (`projects/active/raft/` and `studies/navigation/`)
make the basename **ambiguous**; a bare `[[overview]]` resolves only from a sibling
of one of them. The two `status.md` files are never bare-linked (that would be
ambiguous). `sail-repairs/` deliberately has **no** `_index.md` (only `status.md`),
so it is never used as a directory-link target — with core-only anchors it wouldn't
resolve.

> The directory link uses the **trailing-slash** form `[[…/]]`. The ported resolver
> must strip the trailing slash and resolve to the directory's anchor. The upstream
> reference resolver (`scripts/lib/incremental-indexer.ts`) handled the *bare* dir
> name (`[[raft]]`) but not the trailing-slash form — this fixture is the spec for
> that behavior.

The only unresolved links in the whole corpus are the two intentional
`[[does-not-exist]]` references. Every non-exempt content file has at least one
resolved in- or out-link except `notes/loose-idea.md` (the orphan).

## Binary assets

| File | Kind | Purpose |
|------|------|---------|
| `me/avatar.png` | 1×1 RGB PNG (72 B) | asset pipeline; fallback title `me: avatar` |
| `projects/active/raft/photos/frame.png` | 1×1 RGB PNG (72 B) | asset pipeline; `Build Photo: frame` via `assetTitleRules` |
| `studies/star-chart.pdf` | minimal 1-page PDF (`%PDF-1.4`) | non-image asset / file-type detection |

All three are valid enough for extension-based type detection (`file(1)` identifies
them correctly). They are tiny and deterministic.

## Retrieval goldens (`corpus/evals/`)

`evals/retrieval.jsonl` is a `brain eval` query set over this corpus, pinned to
the reference date by its `{"now": "2026-07-12"}` header. It has at least one query per class:
exact title, natural-language question, paraphrase (inflected words the
stemmer has to join), alias (one of them, `bearingbook`, appears only in the
page's `aliases`, so only alias indexing finds it), ambiguous filename (two `status.md`), time
(a `deadline` and a `next_review` selector), stale-vs-current (`short-bio.md`
against its source `FACTS.md`), no-answer, multi-hop (`current-focus.md` links
to the answer), non-English (the star catalogue's German title) and recency
(a fast-decaying `context` note whose rank moves with the date).

`evals/expected-ranks.json` records, per query, the rank of its expected path
from `brain eval --mode fts --rerank heuristic`, plus `current_first` for
stale-vs-current, and for a no-answer query (rank null by definition) the top
paths it gets instead. The reranker is named on the command line so an
ambient `BRAIN_RERANK_MODE` cannot change what a run or a regeneration sees.
`packages/core/tests/eval-corpus.test.ts` asserts every rank. A change to
ranking therefore fails the suite until the file is rewritten, which puts the
moved ranks in the PR's diff for review:

```sh
BRAIN_UPDATE_GOLDENS=1 bun run test packages/core/tests/eval-corpus.test.ts
```

The test prints a one-line score table (hit@1, MRR@10, hit@1 per class) that a
ranking PR can paste before and after. A separate test in the same file drives
the hybrid lane with hand-staged vectors, both directly and through
`brain eval --mode hybrid` with a deterministic provider in the temp brain's
config; it guards fusion mechanics only.

**These goldens make regressions visible; they do not measure quality.** A
25-document fixture says nothing about how well search serves a real brain.
Measure that with `brain eval` on your own brain (see `docs/evaluating-search.md`).

## Full inventory

29 files: 25 markdown + `brain.config.ts` + 3 binary assets. `evals/retrieval.jsonl`
and `evals/expected-ranks.json` are on disk too, but `evals/` is excluded from the
index by default, so nothing that counts corpus files counts them.

| Path | type | Roles |
|------|------|-------|
| `brain.config.ts` | — | taxonomy config for the corpus |
| `_index.md` | index | root registry (`dir: null`, orphan-exempt) |
| `me/identity.md` | identity | canonical identity; 2-paragraph persona |
| `me/avatar.png` | asset | PNG; fallback asset title |
| `me/basics/FACTS.md` | identity | propagation **source** (updated 2026-06-01) |
| `me/basics/short-bio.md` | identity | propagation derivative — **lags** (2026-05-01) |
| `me/basics/long-bio.md` | identity | propagation derivative — **OK** (2026-06-10) |
| `context/current-focus.md` | context | canonical current-focus; wiki-link hub; `next_review` |
| `context/reading-list.md` | context | second context doc; `next_review` |
| `notes/quick-note-water.md` | note | inbox; `[TODO: …]` marker |
| `notes/quick-note-eagle.md` | note | inbox; `[VERIFY: …]` marker; unresolved link |
| `notes/loose-idea.md` | note | **orphan** + **minimal frontmatter** |
| `projects/active/raft/_index.md` | index | registry table; **index-lag** source; `[[overview]]` sibling case |
| `projects/active/raft/status.md` | project | drives index-lag (2026-06-30); `deadline` field |
| `projects/active/raft/plan.md` | project | qualified-link target |
| `projects/active/raft/overview.md` | project | ambiguous-basename target A |
| `projects/active/raft/photos/frame.png` | asset | `Build Photo` asset-title rule |
| `projects/active/sail-repairs/status.md` | project | `status.md`-led project (no `_index.md`) |
| `projects/active/sail-repairs/materials.md` | project | detail file; second qualified link |
| `projects/archive/one-old-build.md` | project | `match:["projects/"]` outside `dir`; `status: archived` |
| `health/checkup-log.md` | health | fresh; health classifier keywords |
| `health/knee-injury.md` | health | **staleness (warning)**, > 60 d |
| `health/sleep-tracking.md` | health | **stale draft**, > 90 d |
| `studies/star-bearings.md` | study | unique basename; `aliases`; alias-link target |
| `studies/navigation/overview.md` | study | ambiguous-basename target B; study classifier |
| `studies/navigation/star-catalog.md` | study | **unicode title**; alias wiki-link |
| `studies/star-chart.pdf` | asset | minimal PDF |
| `journal/2026-06-15.md` | journal | orphan-exempt; no wiki-links |
| `journal/2026-07-01.md` | journal | orphan-exempt; no wiki-links |
