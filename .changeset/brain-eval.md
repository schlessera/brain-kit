---
"@schlessera/brain": minor
---

New `brain eval` command: scores a retrieval query set against the brain it runs in, using the installed package. Write the queries you actually ask, and the paths that answer them, to `evals/retrieval.jsonl`. `brain eval --mode fts` then reports hit@1/3/10, MRR@10 and an oracle column, overall and per query class. The oracle column separates a document ranked too low from a document never retrieved. A run that cannot be measured refuses to score and exits 2: the set is missing, an expected path does not exist, the index is older than the markdown, or a requested vector lane degraded. `--json` prints a new contract envelope, and `--out <file>` saves it. See `docs/evaluating-search.md`.
