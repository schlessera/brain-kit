---
"@schlessera/brain": minor
"@schlessera/brain-module-finance": minor
---

`_index.md` registry tables can be generated from the children's frontmatter. An index opts in with a `registry:` frontmatter block: `columns` (frontmatter keys, plus `title`, `path` and `link`), and optionally `where`, `sort` and `split`. The new `brain registry` command then writes the table between `<!-- brain:generated:registry -->` markers and keeps every byte of the prose around it. It bumps `updated` only on a file whose table changed. `brain registry --check` writes nothing and exits 1 when a table is out of date. `brain maintain` runs the same step first, as `registry`. `brain audit` checks an opted-in index for the new `index-stale` warning instead of `index-lag`.

Core exports the one generated-region mechanism the project uses (`readGeneratedRegion`, `replaceGeneratedRegion`, `rewriteGeneratedRegion`, `splitFrontmatterBlock`). **module-finance changes a written file format:** its ledgers and dashboard now carry `<!-- brain:generated:finance -->` markers instead of `BEGIN GENERATED` / `END GENERATED`. A file with the old markers is still read, and the next `brain finance sync` rewrites it to the new syntax with the same tables. The ledger template ships the new markers.
