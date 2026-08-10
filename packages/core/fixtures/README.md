# Fixture corpus — `corpus/`

A complete, self-contained fake brain for the fictional persona **Alex Example**, a
park ranger who tracks personal **health**, **woodworking projects**, and evening
**astronomy studies**. It is deliberately *not* a software/speaking persona, so
tests don't accidentally encode the maintainer's real domains.

This corpus is the shared substrate for the integration and contract test layers:
index it into a temp DB, then run FTS-only golden queries and assert
the `--json` envelope shapes. All content is invented; no strings from any real
brain appear here (enforced by the leakage grep in CI).

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
| **Index lag** | `projects/active/bookshelf/_index.md` (2026-06-15) vs sibling `status.md` (2026-06-30) | index lags a detail file by 15 d (> 7) |
| **Orphan (flagged)** | `notes/loose-idea.md` | non-exempt `note`, zero in/out links → orphan |
| **Orphan-exempt** | `journal/2026-06-15.md`, `journal/2026-07-01.md` | linkless but `journal` is `orphanExempt` → not flagged |
| **Classifier: health** | `health/checkup-log.md` (blood pressure, appointment, symptom, prescription) | `classify()` → `health` |
| **Classifier: study** | `studies/telescope-setup.md`, `studies/astronomy/overview.md` (course, lecture, chapter, exercise) | `classify()` → `study` |
| **Asset title (project photo)** | `projects/active/bookshelf/photos/frame.png` | `assetTitleFor()` → `Build Photo: frame` |
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
| `aliases` array | `studies/telescope-setup.md` (`["my scope", "the Dobsonian"]`) |
| `deadline` field | `projects/active/bookshelf/status.md` (`2026-08-15`) |
| `next_review` field | `context/current-focus.md`, `context/reading-list.md` |
| Unicode title (emoji + umlauts) | `studies/astronomy/messier-catalog.md` (`🔭 Messier-Katalog — Deep-Sky Übersicht`) |
| Minimal (only `type`/`title`/`created`/`updated`) | `notes/loose-idea.md` (also the orphan) |
| `[TODO: …]` marker | `notes/quick-note-trailhead.md` |
| `[VERIFY: …]` marker | `notes/quick-note-owl.md` |

### Wiki-link resolution matrix

Each resolver case is exercised by a real link in the corpus. `now`-independent.

| Case | Link (in file) | Resolves to |
|------|----------------|-------------|
| Qualified path | `[[projects/active/bookshelf/plan]]` in `context/current-focus.md` | `projects/active/bookshelf/plan.md` |
| Unique basename | `[[telescope-setup]]` in `context/current-focus.md` (+ others) | `studies/telescope-setup.md` |
| Ambiguous → same-dir sibling | `[[overview]]` in `projects/active/bookshelf/_index.md` | `projects/active/bookshelf/overview.md` (not `studies/astronomy/overview.md`) |
| Unresolved | `[[does-not-exist]]` in `context/current-focus.md` & `notes/quick-note-owl.md` | `null` |
| Alias | `[[telescope-setup\|my scope]]` in `studies/astronomy/messier-catalog.md` | `studies/telescope-setup.md` (display "my scope") |
| Directory link | `[[projects/active/bookshelf/]]` in `context/current-focus.md` | `projects/active/bookshelf/_index.md` (`_index.md` anchor) |

The two `overview.md` files (`projects/active/bookshelf/` and `studies/astronomy/`)
make the basename **ambiguous**; a bare `[[overview]]` resolves only from a sibling
of one of them. The two `status.md` files are never bare-linked (that would be
ambiguous). `trail-signage/` deliberately has **no** `_index.md` (only `status.md`),
so it is never used as a directory-link target — with core-only anchors it wouldn't
resolve.

> The directory link uses the **trailing-slash** form `[[…/]]`. The ported resolver
> must strip the trailing slash and resolve to the directory's anchor. The upstream
> reference resolver (`scripts/lib/incremental-indexer.ts`) handled the *bare* dir
> name (`[[bookshelf]]`) but not the trailing-slash form — this fixture is the spec for
> that behavior.

The only unresolved links in the whole corpus are the two intentional
`[[does-not-exist]]` references. Every non-exempt content file has at least one
resolved in- or out-link except `notes/loose-idea.md` (the orphan).

## Binary assets

| File | Kind | Purpose |
|------|------|---------|
| `me/avatar.png` | 1×1 RGB PNG (72 B) | asset pipeline; fallback title `me: avatar` |
| `projects/active/bookshelf/photos/frame.png` | 1×1 RGB PNG (72 B) | asset pipeline; `Build Photo: frame` via `assetTitleRules` |
| `studies/star-chart.pdf` | minimal 1-page PDF (`%PDF-1.4`) | non-image asset / file-type detection |

All three are valid enough for extension-based type detection (`file(1)` identifies
them correctly). Regenerate with the scripts under the session scratchpad if needed;
they are tiny and deterministic.

## Full inventory

29 files: 25 markdown + `brain.config.ts` + 3 binary assets.

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
| `notes/quick-note-trailhead.md` | note | inbox; `[TODO: …]` marker |
| `notes/quick-note-owl.md` | note | inbox; `[VERIFY: …]` marker; unresolved link |
| `notes/loose-idea.md` | note | **orphan** + **minimal frontmatter** |
| `projects/active/bookshelf/_index.md` | index | registry table; **index-lag** source; `[[overview]]` sibling case |
| `projects/active/bookshelf/status.md` | project | drives index-lag (2026-06-30); `deadline` field |
| `projects/active/bookshelf/plan.md` | project | qualified-link target |
| `projects/active/bookshelf/overview.md` | project | ambiguous-basename target A |
| `projects/active/bookshelf/photos/frame.png` | asset | `Build Photo` asset-title rule |
| `projects/active/trail-signage/status.md` | project | `status.md`-led project (no `_index.md`) |
| `projects/active/trail-signage/materials.md` | project | detail file; second qualified link |
| `projects/archive/one-old-build.md` | project | `match:["projects/"]` outside `dir`; `status: archived` |
| `health/checkup-log.md` | health | fresh; health classifier keywords |
| `health/knee-injury.md` | health | **staleness (warning)**, > 60 d |
| `health/sleep-tracking.md` | health | **stale draft**, > 90 d |
| `studies/telescope-setup.md` | study | unique basename; `aliases`; alias-link target |
| `studies/astronomy/overview.md` | study | ambiguous-basename target B; study classifier |
| `studies/astronomy/messier-catalog.md` | study | **unicode title**; alias wiki-link |
| `studies/star-chart.pdf` | asset | minimal PDF |
| `journal/2026-06-15.md` | journal | orphan-exempt; no wiki-links |
| `journal/2026-07-01.md` | journal | orphan-exempt; no wiki-links |
