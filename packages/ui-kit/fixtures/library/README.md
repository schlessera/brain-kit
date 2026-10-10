# Fixture library

This directory is the world at the size of a brain kept for twenty years: voyage
legs and ship's logs, the crew by ship and by loss, the wider cast, knowledge
and longer studies, Ithaca as news reaches Ogygia, one journal entry per
chosen day, decisions with oaths and omens, and seven years of island records
ending in the raft build. Each record is a `LibraryDocument`
([`types.ts`](types.ts)) that the demo turns into a file with
frontmatter. Each domain owns its path prefixes, and every curated folder has
an index that links up to the goal and down to some of its records.

Stories and baselines do not render it, so adding records moves no visual
baseline. Its invariants are asserted in
[`../../tests/library.test.ts`](../../tests/library.test.ts): unique paths that never
collide with a fixture path, links and full-path `[[wiki-links]]` that resolve
in the curated domains, broken links and orphans exactly as declared,
dates on or before the reference date, `day-N` records dated on day N, ids that
exist, reserved identifiers only, and twelve ship rosters that close against
`crewLosses`. Library records name only the existing people and place ids;
anyone else appears in prose.

Not all of it is tidy, on purpose. A brain kept for twenty years has an inbox
nobody emptied, drafts that were abandoned, notes that belong to three topics at
once and records filed in the wrong folder, and its indexes fall behind. The
`inbox/`, `archive/` and `notes/` records carry that: unprocessed captures with no
summary, status or tags, links written by file name or with a label or a
heading anchor, links to notes that were never written, and a few records that
link nowhere. The folder indexes list only part of what existed when each was
last revised. Every deliberate defect is declared in each mess file's
`KnownIssues`, and the test holds the library to exactly that set: the curated
domains stay clean, and the mess can neither spread nor quietly vanish.

Read [the fixture world's README](../README.md) first: the cast, chronology, ledgers and hazards there are canonical here too.
