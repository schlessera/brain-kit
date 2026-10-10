# Fixture library

This directory is the world at the size of a brain kept for twenty years: voyage
legs and ship's logs, the crew by ship and by loss, the wider cast, knowledge
and longer studies, Ithaca as news reaches Ogygia, one journal entry per
chosen day, decisions with oaths and omens, and seven years of island records
ending in the raft build. Each record is a `LibraryDocument`
([`types.ts`](types.ts)) that the demo turns into a file with
frontmatter. Each domain owns its path prefixes, and every folder has a hub
that links up to the goal and down to its records.

Stories and baselines do not render it, so adding records moves no visual
baseline. Its invariants are asserted in
[`../../tests/library.test.ts`](../../tests/library.test.ts): unique paths that never
collide with a fixture path, links and full-path `[[wiki-links]]` that resolve,
no orphans,
dates on or before the reference date, `day-N` records dated on day N, ids that
exist, reserved identifiers only, and twelve ship rosters that close against
`crewLosses`. Library records name only the existing people and place ids;
anyone else appears in prose.

Read [the fixture world's README](../README.md) first: the cast, chronology, ledgers and hazards there are canonical here too.
