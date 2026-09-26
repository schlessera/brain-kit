---
"@schlessera/brain": minor
---

`brain eval --lint` validates a query set and reports title leakage without scoring and without the index. For each `paraphrase` query it names every content word (stopwords dropped, case ignored) that the query shares with the title of one of its expected documents. Findings are `warnings` and exit `0`. A malformed set exits `2` and names the line. A new `brain-eval` skill grows `evals/retrieval.jsonl` from questions that were actually asked, taken from the current session and an interview. It pairs each question with its answer through `brain search` (or a date selector when the answer depends on the date), and appends the queries only after `--lint` passes.
