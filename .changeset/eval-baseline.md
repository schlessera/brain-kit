---
"@schlessera/brain": minor
---

`brain eval --baseline <file>` compares a run against a stored one (written with `--out`), query by query. It lists which queries were lost, gained and unchanged at each k and per class, with the exact sign-test p for information. It fails (exit 1) on a net loss of `--max-net-loss` (default 2) queries on hit@1, or on any lost query in a `--must-pass` class. Runs that measured different things (set, mode, embedding model, k) are not comparable and exit 3; `--allow-set-change` compares the queries both runs share. `--redact` leaves query text and paths out of the output. `brain doctor` reminds you to rerun the comparison when `evals/baseline.json` was recorded with another version. It never fails, and nothing runs on install.
