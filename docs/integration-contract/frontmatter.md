# Integration contract — frontmatter

Authoritative component of the [integration contract](../integration-contract.md).
Its [shared scope and versioning policy](../integration-contract.md) apply to every section below.

<a id="travel-ownership-and-canonical-content"></a>

## Travel ownership and canonical content

**Approved pre-1.0 breaking ownership change (#566):**
`@schlessera/brain-module-speaking` contributes `talk` and `conference`;
`@schlessera/brain-module-travel` owns the existing `travel` type and
`plan-travel` skill, and adds `trip` and `place`. The
[maintainer ruling](https://github.com/schlessera/brain-kit/issues/60#issuecomment-5869107262)
requires existing content paths, type values, links and travel-party settings
to survive. Both modules retain the shared `status.md`, `itinerary.md` and
`outline.md` directory anchors; travel alone has no speaking deck exclusions.

Install and enable travel before indexing an upgraded speaking-only brain.
Run `brain travel migrate --dry-run --json`, then apply without `--dry-run`,
restart the process and sync skills. The explicit source migration moves the
complete literal `travelParty` field between the canonical package-keyed
config blocks; JSON and directly exported TS literals are supported.
Existing equal values are deduplicated, conflicting or dynamic values are
refused without writes. Content is never rewritten. Speaking temporarily
accepts deprecated `travelParty` and warns when it is nonempty. Existing
`settings/speaking.json` or `settings/travel.json` also causes refusal: #528
owns future JSON precedence and its shared writer. See the
[upgrade instructions](../../packages/module-travel/README.md#upgrade-from-speaking).

Additive travel frontmatter: a `trip` has `trip_status` (`proposed`, `done`,
`dismissed`), optional routes and repeated visits; a done trip has at least
one visit. Visit identity is the owning document's root-relative `.md` path
plus its unique lowercase-slug `id`, independent of date or party. A nonempty
route list has unique labels and exactly one primary; visits name those
labels. `cover`, route GPX and visit tracks/photos resolve relative to their
document within the brain root. Places have `place_kind` (`country`, `city`,
`town`, `spot`), optional parent and coordinates, and references to canonical
visits. Country → city/town → spot ancestry must resolve without cycles.
An existing journey needs no new fields. The full
[field formats](../../packages/module-travel/README.md#canonical-formats) apply.

Visit dates and coordinates stay omitted or null when unknown; `(0, 0)` is
valid. Place counts deduplicate canonical document/visit pairs, including
references from both places and journeys/trips. Stored `visit_count`,
`first_visit`, `last_visit` are display caches and never authority. Bounds
are null if any included date is unknown, and counts still include those
visits. Domain validation uses `brain travel validate`; ordinary
`brain validate` retains its common metadata and wiki-link checks. No schema
version, MCP tool, existing core envelope or database authority changes.
The [decision](../decisions/travel-module.md) explains the boundary.

<a id="travel-photo-copies"></a>

## Travel photo copies

**Additive CLI contract (#567):** `brain travel photo <files> --to <dir> --json`
returns `{photo: {files, errors}}`. Each file has `source: string`,
`output: string`, `width: number`, `height: number`, `bytes: number`,
`captured_at: string | null`, `location: {lat: number, lon: number} | null`, and
`date_source: "exif" | "flag" | "none"`.
`source` is the unchanged input argument; `output` is a root-relative path with
forward slashes. Dimensions and byte length describe the completed JPEG.
Each error has `{source: string, message: string}`; messages are prose.
Both arrays preserve their inputs' relative order.

Capture values come from the original EXIF before stripping. `captured_at`
contains a real calendar date/time in ISO form, with written fractional seconds
and offset retained. Without a written offset it remains local ISO text; no
timezone is inferred. Missing/invalid dates are `null`. A location requires a
finite latitude/longitude pair in −90…90 and −180…180; valid zero values survive,
and unknown/invalid pairs are `null`. No sidecar or content record is written.

Sources resolve from the brain root, or from an explicit absolute path. Their
bytes are unchanged. Outputs stay inside the brain; symlinked output directories
and destination entries are refused. Copies apply EXIF orientation to pixels,
preserve aspect ratio, cap the long edge at 1600 without upscaling, flatten
transparency on white and encode sRGB JPEG with mozjpeg quality 80. Input EXIF,
GPS, XMP, ICC, IPTC and comments are removed. Unsupported raster codecs,
vector documents and animated/multi-page images produce input errors.

Names use the source basename with `.jpg`, then `-2.jpg`, `-3.jpg`, etc.
With `--name <descriptor>`, use `<date>-<slug>.jpg`: the validated EXIF
camera calendar date wins over `--date YYYY-MM-DD`, then a valid flag supplies
the date, otherwise use `undated`. Photo-only `--force-date` makes a valid
`--date` win. Original `captured_at` remains unchanged. `date_source` describes
only the date applied to the requested name: `exif`, `flag`, or `none` for
`undated`; without `--name`, it is always `none` and valid date flags do not
rename anything. Never shift the camera date through UTC or the host timezone.

Photo and route descriptor slugs normalize the complete descriptor to NFKD,
remove Unicode combining marks, lowercase, replace runs outside ASCII
`[a-z0-9_-]` with `-`, and trim edge hyphens. This folds accents without full
transliteration or stripping extensions: `Café in Ithaca` → `cafe-in-ithaca`,
`Straße` → `stra-e`, and `Plan.v2` → `plan-v2`; Greek-only and punctuation-only
descriptors are refused if the result is empty. All supplied date flags must
be real `YYYY-MM-DD` calendar dates (years 0001–9999). Invalid dates, empty
slugs and photo `--force-date` without a valid `--date` refuse before creating
outputs, even without `--name`.

Exclusive publication of completed bytes preserves every existing destination,
including a source already in the output directory. Hard-link support is
required. Temporary cleanup failure after publication does not misreport a
completed copy as failed; a hidden sibling can remain.

Exit `0` means all inputs succeeded. Exit `2` means input failures, with the
same envelope containing any successful copies. Exit `1` means usage or
output-directory refusal before processing, with stderr and no success envelope.
`--human` displays paths/dimensions and stderr errors. `--` terminates options.
The [photo guide](../../packages/module-travel/README.md#photo-copies) documents runtime
requirements. No schema version, MCP tool or existing envelope changes.

<a id="travel-registries"></a>

## Travel registries

**Additive CLI contract (#569):** `brain travel sync [--check] --json` returns
`{sync: {check: boolean, files: string[]}}`. It regenerates the
`travel-trips` region of `<trip dir>/_index.md` and the `travel-places` region
of `<place dir>/_index.md`, creating a missing index with core `type: index`
frontmatter. `files` lists the root-relative registries written, or with
`--check` those that would be written; `--check` writes nothing and exits `1`
when any is listed. A current brain writes nothing and reports `[]`.

Bytes outside the regions are preserved, and `updated` changes only in a file
whose region changed. Counts and bounds derive from canonical visits with the
place deduplication rules above; a country's rollup also counts the visits of
places within it, once per document/visit pair. Unknown dates and coordinates
render as `unknown`. Any `brain travel validate` error, malformed region
markers, a symlinked registry, trip and place types sharing a directory, or a
registry changed after it was read (checked before the first write) exits `1`
with stderr and no success envelope, and neither registry is written. Table layout is prose for
people, not a parsed contract. No schema version, MCP tool or existing envelope
changes.

<a id="braindb-direct-sql-reads"></a>

## brain.db (direct SQL reads)

Prefer the CLI/MCP. If reading directly:

- Check `index_metadata` first: `schema_version` (currently **15**),
  `embedding_model`, `embedding_dimensions`, `vec_schema`, and `fts_tokenizer`
  (additive in 0.38.0): the FTS5 tokenizer `documents_fts` was built with,
  `porter unicode61` for `search.language: english` (the default) or
  `unicode61 remove_diacritics 2` for `none`. It can be absent on an index no
  run has touched since it was added; the table's own definition in
  `sqlite_master` is then the answer. A rebuild for another language writes
  the new table, all its rows and `fts_tokenizer` in one transaction. Schema 9 adds only
  an index on `links(target_id)`; no table or column changed from 8, so a
  reader that accepts 8 reads 9 unchanged. Schema 10 (0.38.0) adds only the
  column `documents.chunker_version`: the chunker version a markdown
  document's chunks came from, `NULL` for assets and for rows written before
  it existed. A reader that accepts 9 reads 10 unchanged.
  Schema 11 (0.38.0) adds only the nullable `documents.generated_from`
  column, so a reader that accepts 10 reads 11 unchanged. The migration also
  clears the markdown rows' `content_hash`, so the next index run re-reads
  every file and fills it. Schema 12 (0.38.0) adds only the table
  `supersedes` (source_id, target, target_id): a document's `supersedes`
  targets as written, and the document each resolves to (`NULL` when none),
  rebuilt by every index run like `links`. A reader that accepts 11 reads 12
  unchanged. Its migration clears `content_hash` the same way.
  Schema 13 (0.38.0) adds only the FTS5 table `chunks_fts` (heading,
  content), an external-content index over `chunks` kept in step by the
  triggers `chunks_fts_insert`, `chunks_fts_delete` and `chunks_fts_update`,
  and built from the existing chunk rows when a writable open migrates the
  database. No table or column a reader selects changed, so a reader that
  accepts 12 reads 13 unchanged. A writer that inserts, updates or deletes
  `chunks` rows keeps the index current through those triggers; it must not
  drop them. `chunks_fts` uses the same tokenizer as `documents_fts`, and a
  `search.language` rebuild recreates it from `chunks` in the same
  transaction. Schema 14 (0.38.0) recreates `documents_fts` with a fifth
  column, `aliases` (a document's aliases, one per line), and no longer
  writes them into its `tags` column. No table or column a reader selects
  changed, so a reader that accepts 13 reads 14 unchanged. The migration
  refills the table from `documents` and clears the markdown rows'
  `content_hash`, so the next index run writes each row again with its
  aliases. It also adds `name_keys` (key, document_id): each markdown
  document's title and aliases, case-folded with whitespace collapsed, the
  lookup exact-name search uses. Titles are keyed at migration; the next index
  run adds the aliases. Schema 15 (0.40.0) adds only the nullable
  `documents.verification` column: a markdown document's `verification`
  frontmatter as written when it is a non-empty string, else `NULL`. A reader
  that accepts 14 reads 15 unchanged. Its migration clears the markdown rows'
  `content_hash`, as schema 11's did, so the next index run fills it.
- Semi-stable tables: `documents` (path, title, type, status, relevance,
  content, deadline, next_review, …), `chunks`, `tags`/`document_tags`,
  `links`, and the derived graph tables `graph_metrics` (document_id,
  in_degree, out_degree, component, pagerank, community), `graph_communities`
  (community, size, label, top_terms JSON), `graph_root_distances`
  (document_id, distance, parent_id) and `graph_layouts` (mode, document_id,
  x, y). Columns are only ever ADDED within a schema_version line.
- The `graph_*` tables are **derived cache, rebuilt wholesale when graph inputs
  change** — they may be empty until the first index run on schema 8, and an
  older CLI writing to a v8 database leaves them stale rather than wrong.
  Unchanged index runs may reuse the graph and preserve its provenance and
  layout; `brain graph compute` and `brain index --force` always rebuild it.
  Internal input fingerprints are disposable and are not a consumer API.
  Their provenance lives in `index_metadata`: `graph_computed_at` (ISO),
  `graph_algo` (JSON parameters), `graph_root` (a document path, or
  `virtual:AGENTS.md` for an index-excluded entry file), `graph_root_links`
  (JSON array of document ids seeded by a virtual root), `graph_node_count`,
  and `graph_layout_skipped` (`"1"` when the corpus was over the layout cap).
  `graph_root` and `graph_root_links` are absent together when no root could be
  resolved, and `graph_layout_skipped` is absent unless the cap was hit — read
  every key as optional.
  A virtual root has no `documents` row; consumers synthesize a node with
  `id: 0` for it. Compare `graph_computed_at` against the newest
  `documents.indexed_at` to detect staleness.
- `vec_chunks` is a sqlite-vec virtual table — unreadable without loading the
  extension; do not depend on it externally. Its dimension is the width the
  stored vectors were produced at, recorded in
  `index_metadata.embedding_dimensions` (1536 on a fresh brain). Changing the
  configured provider does not re-declare the table; a re-embedding run does.
- Open read-only. Writers must set `PRAGMA busy_timeout` (core uses 5000ms).
- **Do not write to brain.db from outside** — markdown is the source of truth.

Everything above is enforced by `tests/brain-db-contract.test.ts`, which indexes
the fixture corpus with the real CLI and then reads it back with the shipped
`ui-server` readers. `schema_version` has exactly one source — `SCHEMA_VERSION`,
exported from `@schlessera/brain` — and that test fails when this document, the
`brain doctor` check, or a reader floor disagrees with it.

<a id="file-layer-contracts"></a>

## File-layer contracts

- Markdown files: YAML frontmatter per `CONTRACT.md` (shipped in the package);
  `deadline` / `next_review` are ISO dates queried by briefing features.
- Optional `generated_from` (additive in 0.38.0): a non-empty string, either a
  repo-relative path to the document's source or a free-form tool name. It
  marks the document as produced by a tool or an agent pass, not written by
  hand. `brain validate` reports any other value as an error. `brain audit`
  reports a `propagation` issue when it names a markdown document updated
  after this one. The heuristic reranker weights a generated document ×0.85.
- Optional `verification` (additive in 0.40.0): `verification: unverified`
  declares the whole document unverified. `brain audit` then reports exactly
  one `verify` issue (`info`) for it, however many inline `[VERIFY: …]`
  markers it has. It is a declaration, not a state machine: there is no
  `verified` value, and a document without the field is not thereby verified.
  `brain validate` warns on any other value.
- Optional `supersedes` (additive in 0.38.0): on a newer document, the
  document or documents it replaces, as a wiki-link target (`"[[plan]]"` or
  `plan`) or an inline list of them, resolved like a body wiki-link, aliases
  included. Search multiplies a superseded document's score by 0.85 after
  fusion and reranking, in every mode and with `rerank: none`, and marks the
  result with `supersededBy`; the document stays in the results. `brain
  validate` reports as errors a value that is not one complete target or a
  non-empty list of them (an empty, blank or null entry, an unclosed `[[`, an
  empty `[[]]`), an unresolved target, and every document on a cycle (a
  document superseding itself through a chain), naming the others. A
  filter-only search (no query) marks `supersededBy` too, without reordering.
- `brain archive` / `brain_archive` set `status: archived` and bump `updated`.
  Since 0.38.0 they also set `relevance: historical` when relevance is
  `primary` or missing, and leave an explicit `secondary` or `historical`
  alone (additive). `brain validate` warns on `status: archived` with
  `relevance: primary`.
- The configured inbox dir (default `notes/`) with `status: active` =
  unprocessed inbox (capture targets this).
- Committed sidecars `.context-cache.jsonl` / `.asset-cache.jsonl`:
  content-hash-keyed `{k,v}` JSONL, appended from the db after embeddings
  runs — a committed value is never overwritten, a duplicated key resolves to
  its first line in sorted order, and a run with nothing new does not write
  the file. Machine-managed, union-merge on conflict, never hand-edit.
  Templates ship them empty.
- Committed `.stats-history.jsonl` (additive in 0.40.0): one `brain stats`
  snapshot per day, written by `brain maintain` and `brain stats --record`
  (see "Stats history"). Machine-managed; a brain gains it on its first
  recording, so templates need not ship it. `brain sync` commits it with the
  `config` group. It is union-merged like the sidecars: the template's
  `.gitattributes` carries `.stats-history.jsonl merge=union`, and `brain
  doctor --fix` appends the line to a brain without it. After a union merge,
  two lines for one day resolve to the later recording.
- Generated regions (additive in 0.38.0): content a command derives and keeps
  inside a hand-written markdown file sits between
  `<!-- brain:generated:{name} -->` and `<!-- /brain:generated:{name} -->`.
  Everything outside the markers is the author's and is never rewritten, byte
  for byte, trailing whitespace and line endings included; a region is
  rewritten, and the file's `updated:` bumped, only when its content changed. A
  marker counts only on a line of its own and outside code, so one quoted
  inside a line or in a fenced example is text.
  A file with a stray, doubled or out-of-order marker line is not rewritten;
  the command reports it instead, as it does a file whose frontmatter never
  closes. Generated values, the registry's cells and module-finance's alike,
  render a line break as a space, `|` as `\|` and `<!--` as `&lt;!--`
  (`inertGeneratedText`). `brain registry` owns the `registry` region of an
  `_index.md`, and module-finance the `finance` region of its ledgers and dashboard (which
  replaced its older `BEGIN GENERATED` / `END GENERATED` markers; those are
  still read and are rewritten to the region on the next `brain finance sync`).
- An `_index.md` opts in to a generated registry table with a `registry:`
  frontmatter block (additive in 0.38.0): `columns` (frontmatter keys, plus
  `title`, `path` relative to the index, and `link` as a `[[wiki-link]]`),
  optional `where: { key: [values] }`, optional `sort` (a column key, `-` for
  descending) and optional `split`: a key (one table per value), or
  `{ key, tables: { Label: [values] } }` (one table per label, in the listed
  order, left out when empty, then one per value no label took; a label that
  is a whole number, such as `"2"`, is rejected, since it would not keep its
  listed order; additive in 0.38.0). Its children
  are every markdown file under the index's directory, at any depth, other than
  an `_index.md`.
- module-jobs' opportunity `status.md` records the pipeline in frontmatter
  (additive in 0.38.0): `stage` (`researching`, `applied`, `screening`,
  `interviewing`, `offer`, `closed`), `fit` (`strong`, `medium`, `weak`),
  `applied` (a date), `next_step` (a string, whose date is the core `deadline`)
  and `closed_reason` (a string). A closed opportunity also carries
  `relevance: historical`. `brain jobs pipeline` generates the opportunities'
  `_index.md` from these fields; its audit checks report category `jobs-stage`.
- Module data files (e.g. module-jobs' `jobs.db`) are documented by the module
  that owns them.
- The scratch area `.brain/scratch/` (additive in 0.38.0) holds transient
  output and is never canonical: excluded from the index, stats and OKF
  export, and pruned to 7 days and 1 GB. Four writers are held to its rules
  and prune after writing: `brain render` (`--scratch`, stdin without `--out`,
  or `--out` into it), `brain image` (`--scratch` or `--out` into it),
  `brain okf export --out` into it, and the chat UI's `request_image_mask`
  beside a draft there. Each refuses to write until git excludes the
  directory itself (`brain doctor --fix` adds the line; a rule on the files
  alone does not count) and refuses a `.brain` or `.brain/scratch` that is a
  symlink. Other commands that write where a caller points them (`add`,
  `import`, pi's `write_file`, module data files) are canonical-content
  writers and are not held to scratch rules. The periodic pass is `brain
  maintain` (the hosting container runs it daily), `brain scratch prune`, and
  the chat server hourly. A file there may vanish at any time; a consumer that
  wants to keep one moves it out.

