---
"@schlessera/brain": patch
---

The brain template ships search evaluation. `bun run eval` scores `evals/retrieval.jsonl` keyless (full-text; add `-- --mode hybrid` with an embedding key), and `bun run eval:baseline` stores a run to compare against after upgrading. The README has a "Measuring search" section with example query lines (a fixed answer, a date selector and a no-answer question), and an "After upgrading" section. Nothing runs on install. A new brain also has an `evals/` directory, which is never indexed.
