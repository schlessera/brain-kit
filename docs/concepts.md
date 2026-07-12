# Concepts

The ideas behind brainform, and the file-layer conventions every part of the
system agrees on. Read this once and the CLI, the skills, and the config file
all make sense.

## Markdown is the source of truth; the index is disposable

This is the property everything else hangs on.

Your knowledge lives in **markdown files under git**. The search index
(`brain.db`, a SQLite database) is a *derived cache*. It is built from the
markdown and can be thrown away and rebuilt at any time:

```sh
brain index --force   # deletes and regenerates brain.db from the markdown
```

Nothing is ever authoritative in `brain.db` that is not already in a file.
Practical consequences:

- **Never write to `brain.db` directly.** Create or edit markdown (or call
  `brain add` / the MCP write tools) and let the indexer sync.
- **Upgrades are re-indexes.** A new `@brainform/core` with a new schema does
  not need a data migration — `brain index --force` regenerates everything.
- **Your data outlives the tool.** The files are plain markdown; they are
  readable, greppable, and portable with or without brainform.

The database schema, chunking, and ranking pipeline are deliberately *not*
extensible for this reason — they are an implementation detail of a disposable
cache. See [extending/README.md](extending/README.md) for the full
not-pluggable list.

## Frontmatter schema

Every content document starts with a YAML frontmatter block. The shipped agent
contract (`@brainform/core/CONTRACT.md`) defines it; this is the same schema
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
   `@brainform/module-speaking` adds `talk`, `conference`, and `travel`. See
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

1. **Qualified target** (contains `/`): matches by path suffix.
   `[[projects/acme]]` resolves to `**/projects/acme.md`.
2. **Unique basename**: `[[acme]]` resolves to the only `acme.md` in the corpus.
3. **Ambiguous basename**: when several `acme.md` exist, it resolves to a
   sibling in the *same directory* as the linking file.
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
- **Orphans** — a document no wiki-link points to. Types marked `orphanExempt`
  (core: `context`, `index`) are excused.
- **Type/directory mismatch** — a document whose `type` does not match where it
  lives, per the taxonomy's accepted prefixes.
- **Propagation lag** — a derivative document older than the canonical source it
  derives from (configured via `taxonomy.propagation`).
- **Silent edits** — content changed without bumping `updated`. `brain accept-mtime`
  baselines these once you have reviewed them.

Skills (`audit`, `content-hygiene`) sit on top: they triage findings, apply the
mechanically-safe fixes, and propose the judgment calls to you.

## Sidecar caches

Two committed sidecar files speed up embeddings without becoming a second source
of truth:

- `.context-cache.jsonl` — generated chunk contexts.
- `.asset-cache.jsonl` — generated descriptions of binary assets.

Both are content-hash-keyed `{k, v}` JSONL, rebuilt from `brain.db` after an
embeddings run. They are **machine-managed**: never hand-edit them; on a git
conflict they union-merge. Templates ship them **empty**. Because they are keyed
by content hash, they survive provider switches — only the entries whose inputs
changed are recomputed.

## See also

- [quickstart.md](quickstart.md) — go from clone to a working brain.
- [configuration.md](configuration.md) — the full `brain.config.ts` reference.
- [modules.md](modules.md) — types, skills, and CLI words modules add.
- [integration-contract.md](integration-contract.md) — the stable machine surface.
