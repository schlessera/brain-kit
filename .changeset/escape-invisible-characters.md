---
"@schlessera/brain": patch
"@schlessera/brain-ui-react": patch
---

Spell control and invisible characters as escapes so grep can see the source

`chunkContextKey` embedded raw NUL bytes as hash field separators, which makes
grep and ripgrep classify `indexer.ts` as binary — the file silently dropped out
of every search. `brain-markdown.tsx` had the milder version: its entity
delimiters were runs of one, two and three literal zero-width spaces, unreadable
in a diff and destroyable by any editor that trims whitespace.

Both now use escape sequences. The runtime strings are byte-identical, so
existing `.context-cache.jsonl` keys still match and no LLM-generated context is
regenerated.

`bun run lint` (`scripts/check-invisibles.ts`) refuses raw control and invisible
characters in tracked files and runs in CI as the invisible-character gate.
