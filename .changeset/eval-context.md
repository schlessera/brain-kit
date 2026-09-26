---
"@schlessera/brain": minor
---

`brain eval --context [--budgets 1000,4000,8000]` measures what `brain context` hands an agent. Every query runs through the same assembler at each budget. It reports whether the answer is there (an expected path heads a result section, or an optional `answer` string appears in the text) and how much of the budget the output uses (median, p10, p90), in a new `context` block of the `--json` envelope. The assembler's search now takes the run's pinned `now`, so a date-pinned set gives the same context on any day.
