# Frontmatter parsing bypasses gray-matter's cache, by construction (2026-09-30)

Every frontmatter parse in the tree goes through one helper,
`parseFrontmatter` (`parseFrontmatter`,
`packages/common/src/frontmatter-parse.ts:28-30`), which always passes
gray-matter an options object. A lint gate refuses every other way of reaching
gray-matter's parser. Issue #142 holds the reproductions and the ruling.

## The problem

gray-matter 4.0.3, called as `matter(input)` with no options, keeps a
process-wide cache keyed by the exact input string. That caused three separate
failures:

1. **Shared data.** A byte-identical input is answered with a shallow copy of
   the cached file object, so every such parse shares one nested `data`. The
   first parse returns the cached object itself. A caller that updated one
   document's parsed data in place therefore changed what was later read for
   any other document with the same bytes, in the same process.
2. **A failure cached as a success.** The entry is stored before the YAML is
   parsed. When the parse throws, the unparsed entry stays in the cache, and
   the next parse of the same bytes returns it: no exception, `data` is `{}`,
   and `content` is the whole file. In the long-lived chat server, the
   indexer's second pass over a broken file reported "missing required
   frontmatter" instead of "invalid frontmatter".
3. **Unbounded retention.** Nothing is ever evicted, so every distinct
   document string stays in memory for the life of the process.

gray-matter skips the cache entirely whenever an options object is passed.
Before this record, about half of the callers already passed `{}`, each
with its own comment explaining why, and the rest did not.

## Decision

**One cache-free helper, enforced; not a convention at each call site.** The
maintainer chose option B on #142 on 2026-09-28.

- `parseFrontmatter(input, options?)` calls `matter(input, { ...options })`.
  The caller's options are kept, and gray-matter's own `defaults()` copies
  them again, so the caller's object is never mutated. An object is always
  passed, so the cache is never read or written. Parsing behaviour is
  otherwise unchanged, and the tests pin it: dates, byte order mark, CRLF,
  empty, missing and unclosed blocks, custom delimiters, engines, excerpts.
- **One internal leaf package, not a copy per package** (#1396, maintainer
  ruling 2026-10-09). The helper lives in `@schlessera/brain-common` and is
  reached through its `./internal/frontmatter` entry, which carries no
  compatibility promise ([public export boundary](public-export-boundary.md)).
  Every package that parses frontmatter depends on it; tests and root scripts
  import it the same way or by path. Only this package and core, for the
  serializer below, depend on gray-matter.
- **The gate:** `scripts/check-frontmatter-parse.ts`, run by `bun run lint`.
  It is AST-based and scans every package's `src`, `tests` and `scripts`, plus
  the root `scripts/` and `tests/`. It enforces two rules.
  - Rule 1: gray-matter may be loaded (`import`, `import type`, `export …
    from`, `import x = require()`, `require()`, `import()`, subpaths) only by
    the files in its `ALLOWED` list (`ALLOWED`,
    `scripts/check-frontmatter-parse.ts:40-57`).
  - Rule 2: inside those files, the default binding may only be called with an
    object literal where gray-matter takes its options, or named in a type.
    Aliases, re-exports, `matter.read`, `matter.cache` and variable options
    are refused, because a variable can be `undefined` at run time.
- **The one justified non-parsing use** is `stringifyDocument` in
  `packages/core/src/lib/frontmatter.ts`. `matter.stringify` parses its content
  argument too, but only with the options it is given, and the gate requires
  those to be a literal. The other listed file is the test that seeds and
  reads the cache to prove the helper ignores it.

## Rejected alternatives

- **Pass `{}` at every call site (O1).** This was already half-done, and the
  other half is how the bug survived: nothing stops the next call site from
  forgetting.
- **Deep-copy `data` at the known writers (O3).** It fixes only the aliasing,
  and only for the writers someone remembered. The cache still grows, and the
  cached failure still reads as a success.
- **Periodically clear `matter.cache`.** It still shares objects between two
  clears. It is also global state that another consumer in the process may
  rely on.
- **A faster cache of our own.** Out of scope by ruling. The measurement below
  also shows there is nothing to win back.
- **Replace gray-matter.** Out of scope. It would change parsing semantics,
  which this fix must not do.

## Measurement

The work was run on 2026-09-30 in a 4-CPU container with Bun 1.3.11. It used
the fixture corpus `packages/core/fixtures/corpus/` (25 documents) and a 20×
corpus (481 documents), made by copying each content directory into 19
`copy-N` subdirectories. The 20× copies are byte-identical, which is the case
where the old cache could hit. Each lane ran 12 times, and the first 2 runs
were discarded as warm-up. Keyless, with no embeddings.

| Lane | Before (median, min–max) | After (median, min–max) |
| --- | --- | --- |
| `brain index --force`, fresh process, 25 docs | 743 ms (691–872) | 740 ms (681–823) |
| `brain index --force`, fresh process, 481 docs | 9635 ms (9136–10134) | 9780 ms (9357–10839) |
| `indexAll` repeated in one process, 25 docs | 230 ms (211–273) | 246 ms (218–295) |
| gray-matter cache entries left after that lane | 25 | 0 |

The one-process lane at 481 documents first read 8733 ms before and 10517 ms
after, which would be a +20% regression. That was too large to come from
parsing. A direct timing put 500 parses of the corpus at 17–33 ms through the
helper, against about 1 ms when the cache answered. So that lane was rerun
with the two trees interleaved: before, after, before, and so on, three times
each, in fresh processes. The medians were 9502, 9374 and 9032 ms before, and
9532, 9344 and 9386 ms after. The earlier gap was drift between two
sequential runs, not the change.

The cache saved about 30 µs per re-parse of identical bytes. Against an index
run that spends about 20 ms per document on other work, that is not
measurable. The fresh-process CLI never hit the cache anyway, because each
file is parsed once per run.

## Changing this

- A package that starts parsing frontmatter adds `@schlessera/brain-common`
  to its dependencies and its edge to `tests/allowed-edges.ts`.
- An edit to the helper is made once, in `packages/common`.
- A new entry in `ALLOWED` needs a reason that says why the file cannot reach
  the cache. "It only parses once" is not one: the cache is process-wide.

## Superseded: a copy per parsing package

Until #1396 the helper was not shared. `ui-server` did not depend on core, and
exporting it from `@schlessera/brain` would have widened the public API that
#534 was curating, so core held the canonical copy and `module-finance`,
`module-jobs`, `module-travel` and `ui-server` each carried a byte-identical
`src/lib/frontmatter-parse.ts`, held identical by a sync test, following the
`env-core.ts` copies of the environment chokepoints. The maintainer ruled on
2026-10-09 (#1347) to replace both sets of copies with one published leaf
package whose entries are internal: a shared utility package is not an
extension interface, so the no-new-seams rule does not apply, and a package
cannot be left unpublished because consumers install every package from npm.
