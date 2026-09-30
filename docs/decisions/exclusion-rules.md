# Exact files and directory exclusions

**Decided by the maintainer on 2026-09-29 in #224.**

An exact file exclusion cannot exclude a directory. Config loading rejects an
`exclude.files` entry ending in `/` with an actionable error naming the value
and directing the author to `exclude.dirs`. Directory traversal and checks
that an output directory is excluded use only directory and segment rules.
Programmatic taxonomy callers receive the same directory protection even
when they bypass schema validation.

## Evidence and rationale

With `files: ["drafts/"]`, indexing considered each file independently and
included `drafts/a.md`. Stats instead asked whether `drafts/` was excluded
before descending, matched the exact-file entry and omitted the whole tree.
The runtime regression fixture indexes seven eligible nonempty notes totaling
519 bytes, while the old stats walk reports four files and 377 bytes. A
separate loading test confirms both JSON and TypeScript configs accepted the
invalid entry before validation was tightened.

The caller audit found the same distinction in OKF output authorization:
`files: ["published"]` made the old check accept an output directory even
though `published/note.md` remained visible to indexing. Output authorization
now asks the directory question explicitly, using the same rules as stats.

## Alternatives rejected

- **Only change directory pruning.** It prevents count discrepancies but
  silently accepts mistaken configuration. Rejecting the trailing slash tells
  the author how to express the intended directory exclusion.
- **Only validate config.** Programmatic callers can bypass validation; the
  directory check must enforce its own semantics.
- **Convert a trailing-slash file entry into a directory exclusion.** It
  silently changes which documents are indexed. Require an explicit edit to
  `exclude.dirs` instead.
- **Retain the mismatch and explain it.** A corpus figure must agree with the
  exclusions indexing uses.

Valid exact-file matching and existing directory/segment rules are preserved.
The newly rejected config is an approved pre-1.0 compatibility tightening,
versioned as a minor under [contract-versioning.md](contract-versioning.md).
