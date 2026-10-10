# Concepts

The ideas behind brain-kit, and the file-layer conventions every part of the
system agrees on. Read this once and the CLI, the skills, and the config file
all make sense.

## Markdown is the source of truth; the index is disposable

This is the property everything else hangs on.

Your knowledge lives in **markdown files under git**. The search index
(`brain.db`, a SQLite database) is a *derived cache*. It is built from the
markdown and can be thrown away and rebuilt at any time:

```sh
brain index --force   # rebuilds the derived index from the markdown
```

Nothing is ever authoritative in `brain.db` that is not already in a file.
Practical consequences:

- **Never write to `brain.db` directly.** Create or edit markdown (or call
  `brain add` / the MCP write tools) and let the indexer sync.
- **Upgrades are re-indexes.** A new `@schlessera/brain` with a new schema does
  not need a data migration — `brain index --force` regenerates everything.
- **Your data outlives the tool.** The files are plain markdown; they are
  readable, greppable, and portable with or without brain-kit.
- **What git ignores, the index ignores, for assets only.** An image or PDF
  that git ignores lives on one clone, so it is not described, embedded or
  searchable. Gitignored markdown is still indexed. See
  [configuration.md](configuration.md#exclude).

The database schema, chunking, and ranking pipeline are deliberately *not*
extensible for this reason — they are an implementation detail of a disposable
cache. See [extending/README.md](extending/README.md) for the full
not-pluggable list.

## Frontmatter schema

Every content document starts with a YAML frontmatter block. The shipped agent
contract (`@schlessera/brain/CONTRACT.md`) defines it; this is the same schema
with examples.

```yaml
---
type: note            # one of the types in brain.config.ts (see `brain config check`)
title: Human title
created: 2026-01-01   # bare YYYY-MM-DD, never quoted, never a timestamp
updated: 2026-01-05   # bump whenever you meaningfully edit the file
tags: [a, b]          # inline flow style
status: active        # active | draft | archived
relevance: primary    # primary | secondary | historical
---

The body is ordinary markdown. Link to other documents with [[wiki-links]].
```

Optional fields:

| Field         | Type          | Meaning                                                    |
| ------------- | ------------- | ---------------------------------------------------------- |
| `summary`     | one line      | Used in search results and briefings.                      |
| `aliases`     | inline array  | Extra names a `[[wiki-link]]` can resolve to.              |
| `deadline`    | bare ISO date | Surfaced by `brain briefing`.                              |
| `next_review` | bare ISO date | Surfaced by `brain briefing` when due.                     |

Rules that keep the corpus machine-friendly:

- **Bump `updated` when you change content.** Mechanical/format-only edits may
  skip it — then run `brain accept-mtime` to re-baseline silent-edit detection.
- **Dates stay bare `YYYY-MM-DD` scalars.** No quotes, no timestamps.
- **Arrays stay inline** (`[a, b]`), not block lists.
- **`status: archived` removes a doc from default search.** It is how you retire
  content without deleting history.

### Statuses and relevance

`status` is the lifecycle of a document:

- `active` — live content. In the inbox directory, `active` also means
  *unprocessed* (see [Notes inbox](#notes-inbox)).
- `draft` — captured but not yet fully shaped.
- `archived` — retired; excluded from default search, kept for history.

`relevance` is how central a document is, independent of its status:

- `primary` — core, current knowledge.
- `secondary` — supporting detail.
- `historical` — kept for the record, rarely the answer you want first.

## Document types and the taxonomy model

A **type** answers "what kind of document is this, and where does it live?" Types
map to directories, and the mapping is the *taxonomy*.

The effective taxonomy is a merge of three layers:

```text
effective taxonomy = core built-ins  ⊕  module contributions  ⊕  your brain.config
```

1. **Core built-ins.** Every brain has these four types no matter what:

   | Type       | Directory   | Notes                                            |
   | ---------- | ----------- | ------------------------------------------------ |
   | `identity` | `me/`       | Who you are; `me/identity.md` is canonical.      |
   | `context`  | `context/`  | Current focus; goes stale after 30 days.         |
   | `note`     | `notes/`    | The capture inbox (see below).                   |
   | `index`    | *(any dir)* | `_index.md` registry files; skips dir checks.    |

2. **Module contributions.** Enabling a module adds its types — for example
   `@schlessera/brain-module-speaking` adds `talk` and `conference`;
   `@schlessera/brain-module-travel` adds `travel`, `trip` and `place`. See
   [modules.md](modules.md).

3. **Your `brain.config.ts`.** You add your own types and may override any
   existing type's settings. See [configuration.md](configuration.md).

### Collision rules

The merge is strict so the taxonomy can never be ambiguous:

- A module that **redefines a type already owned by core or another module** is a
  hard validation error.
- **Two types claiming the same directory prefix** is a hard validation error —
  path-to-type inference must be unambiguous.
- **You may override an existing type** from your `brain.config.ts` (adjust its
  `staleDays`, add `match` prefixes, etc.) — that is an intentional merge, not a
  collision.
- **Exactly one type must be the inbox** (`inbox: true`). Core marks `note`;
  removing that without designating another inbox type is an error.

Every path question — which directory a type creates in, which type a path
belongs to, how stale a file is, which anchor a directory link resolves to — is
answered by a single resolver built from this merge. There is no second source
of truth to drift out of sync.

## The `_index.md` convention and the Index Sync Principle

Every content directory keeps an `_index.md` file (type `index`): a one-line
purpose blurb plus a registry table of the directory's children.

The **Index Sync Principle** is the rule that keeps summaries honest:

> Update the summary layers (`_index.md`, the current-focus doc) in the *same
> operation* as the detail files they summarize.

If you add `projects/active/new-thing.md`, you update `projects/active/_index.md`
in the same change. `brain audit` flags summary layers that lag behind their
details, so drift is caught rather than accumulated.

## Wiki-link resolution

Links between documents use `[[target]]` or `[[target|display text]]`. Resolution
runs in this order:

1. **Qualified target** (contains `/`): an exact repo-relative path wins.
   Otherwise match by path suffix and apply source-directory disambiguation;
   multiple candidates with no unique local match stay unresolved.
2. **Unique basename**: `[[circe]]` resolves to the only `circe.md` in the corpus.
3. **Ambiguous basename**: first try a unique match in the source file's
   namesake subdirectory, then walk its ancestor directories from nearest to
   farthest. A scope with multiple matches stays unresolved.
4. **Unresolved**: if none match, the link is left unresolved and `brain validate`
   reports it. Links are never silently guessed.

Two more forms:

- **Directory link** (trailing slash): `[[some/dir/]]` resolves to the
  directory's anchor file — `_index.md` first, then any module-contributed
  anchors (`status.md`, `itinerary.md`, …), in order.
- **Heading link**: `[[file#heading]]` resolves to the file (the heading is a
  human hint).

`aliases:` in a document's frontmatter add extra basenames that resolve to it.

## Notes inbox

The configured **inbox directory** (default `notes/`, the type marked
`inbox: true`) is where quick capture lands. A note there with `status: active`
means *unprocessed*.

```sh
brain add "a thought I want to keep"   # writes to the inbox with valid frontmatter
```

Quick capture is deliberately loose about placement — the goal is to get the
thought in with zero friction. The `process-notes` flow is where notes get a
proper home: filed into the taxonomy, enriched, merged, or archived, with index
registries kept in sync. A brain works fine with everything typed `note`; filing
is an improvement, not a requirement.

## Staleness and the audit model

`brain validate` and `brain audit` are the maintenance loop. Validation is about
correctness (schema, unresolved links); audit is about health.

`brain audit` reports, per document:

- **Staleness** — a document older than its type's threshold. Thresholds come
  from the type's `staleDays` / `staleSeverity`; types without an explicit rule
  fall back to the default (180 days, `info` severity). `context` is stale after
  30 days (`warning`) because current-focus notes rot fast.
- **Index lag** — a summary layer (`_index.md`, current-focus) older than the
  details it summarizes (the Index Sync Principle, enforced).
- **Orphans** — a document with no outgoing wiki-link, no resolved incoming
  wiki-link and no incoming plain Markdown link from an indexed document
  (including registry links). Types marked `orphanExempt` (core: `context`,
  `index`) and `_index.md` files are excused. An unresolved outgoing link is
  still a broken-link finding; it does not also make its source an orphan.
- **Type/directory mismatch** — a document whose `type` does not match where it
  lives, per the taxonomy's accepted prefixes.
- **Propagation lag** — a derivative document older than the canonical source it
  derives from (configured via `taxonomy.propagation`).
- **Silent edits** — content changed without bumping `updated`. `brain accept-mtime`
  baselines these once you have reviewed them.
- **Broken links** — a wiki-link that resolves to nothing, by the same rules
  `brain validate` uses (a `warning`).
- **Markers** — `[TODO: …]` and `[VERIFY: …]` notes, one `info` finding per
  document and kind with the count and the first three. A document whose
  frontmatter says `verification: unverified` gets one `verify` finding
  whatever it contains.

Severity is the one classification. Errors and warnings are **must-fix**: a
defect the audit can show. Infos are **informational**: worth reading, not
wrong. `brain audit` and `brain maintain` report both totals beside the
severity counts, and every count is of findings, so a research file with forty
markers counts once per kind. The reasoning is in
[decisions/audit-markers.md](decisions/audit-markers.md).

`brain audit --fix` reports deterministic repair availability without calling a
completion provider or changing files. Only a stale opted-in registry that passes
path, type and validation checks can carry `canAutoFix: true` and `repair`
metadata. Availability grants no permission to run the repair; other findings
remain manual.

Skills (`audit`, `content-hygiene`) sit on top: they triage findings, apply the
mechanically-safe fixes, and propose the judgment calls to you.

## Sidecar caches

Two committed sidecar files speed up embeddings without becoming a second source
of truth:

- `.context-cache.jsonl` — generated chunk contexts.
- `.asset-cache.jsonl` — generated descriptions of binary assets.

Both are content-hash-keyed `{k, v}` JSONL, appended from `brain.db` after an
embeddings run. They are **machine-managed**: never hand-edit them. They
union-merge in any git merge, not only in `brain sync`: the template's
`.gitattributes` gives both files git's built-in `merge=union` driver, and
`brain doctor --fix` adds it to a brain that lacks it. Templates ship them **empty**. Because they are keyed
by content hash, they survive provider switches — only the entries whose inputs
changed are recomputed.

An embeddings run only adds the keys a file lacks. A value already committed
stays, even when this clone's database generated different text for the same
key, so two clones syncing with no content change leave the files untouched. A
key that appears twice resolves to its first line in sorted order, the same on
every clone, and `brain sync pull` applies the same rule when it unions this
clone's lines with the merged file. An asset description is reused for the same
bytes under any title, and is kept while any indexed asset still has those bytes. Contexts are keyed by chunk text,
so two clones on different chunker versions chunk the same documents
differently: each prunes the other's contexts as unreachable and regenerates
its own, and the cache changes on every sync until both run the same
`@schlessera/brain`.

To discard a bad entry, run `brain index --forget-cache <path>`: it removes that
document's or asset's lines and resets it in `brain.db` (together with any other
document or asset that shares those keys or bytes), so the next
`brain index --embeddings` generates it again.

Asset enrichment returns `null` when the completion provider has no vision
or answers with empty/whitespace text. The asset keeps its `[Image: path]` or
`[PDF: path]` placeholder and searchable title; its placeholder is neither
cached as a description nor embedded. A later `--embeddings` run retries the
unchanged asset and stores a real, non-empty description when one is returned.

Before this behavior changed (#411), a title fallback could be stored as a
successful description. Existing strings carry no provenance that separates
those fallbacks from real descriptions that happen to equal a title. Upgrading
does not automatically delete or reclassify them. Rebuilding `brain.db`, even
with `--force`, can reuse a stale sidecar entry and does not repair it.

For an entry you have identified as bad, with its asset still indexed, run:

```sh
brain index --forget-cache assets/diagram.png
brain index --embeddings
```

The first command removes every sidecar description for those bytes under
any title, restores placeholders in document, chunk and full-text rows for
all indexed copies, and drops their vectors. It runs no index pass. The second
command regenerates with the configured completion and embedding providers;
a vision-capable completion provider must return non-empty text to finish the
description. Other assets keep their cache entries. If the database was lost,
first run `brain index --embeddings` to register the asset (it may reuse the
bad entry), then forget that indexed path and regenerate. Do not hand-edit or
mass-delete the cache to guess which historical strings were fallbacks.

## See also

- [quickstart.md](quickstart.md) — go from clone to a working brain.
- [configuration.md](configuration.md) — the full `brain.config.ts` reference.
- [modules.md](modules.md) — types, skills, and CLI words modules add.
- [integration-contract.md](integration-contract.md) — the stable machine surface.
