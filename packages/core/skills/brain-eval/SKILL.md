---
name: brain-eval
description: Use when growing the brain's retrieval query set (`evals/retrieval.jsonl`) from questions that were actually asked, so `brain eval` measures search on real questions rather than ones written while looking at the answer. Also use when the user wants to know whether search finds what they ask for.
compatibility: Requires the brain CLI. Scoring the vector or hybrid lane needs an embedding key; collecting and linting queries does not.
---

# Brain eval — Grow the Query Set from Real Questions

A query written while looking at its answer borrows the answer's words, which flatters
keyword search. The questions worth keeping are the ones someone actually asked. This skill
collects them, pairs each with the documents that answer it, and appends them to the brain's
query set.

**This skill orchestrates; `brain eval` executes.** Validating the set and checking for
title leakage is `brain eval --lint`; scoring is `brain eval`. Do not re-implement either.
The set format is in `docs/evaluating-search.md` of the brain-kit package.

## 1. Collect candidate questions

Two sources, and only these two:

- **This session.** List the questions the user asked in this conversation that searched
  the brain for an answer. Use their wording, not a tidied version.
- **The user.** Ask: "What have you asked your brain, or wanted to, that it did or did not
  answer well?" Take each answer down as they say it.

Do not read agent transcript files and do not invent questions. A question you phrase
yourself after finding the answer is exactly what this skill exists to avoid.

## 2. Pair each question with its answer

For each question, keep `q` exactly as it was asked. Then find the answer, in this order:

1. Run `brain search "<q>" --json` and read the top results. Also search with other words if
   the right document did not come up. A question search cannot answer yet is the most
   valuable kind to keep.
2. Propose the documents that answer it and let the user confirm or correct the list. Any one
   of them counts as a hit.
3. If the right answer depends on the date ("what is due next", "what changed this week"),
   propose a selector (`expect.select`) instead of fixed paths, and say which frontmatter
   field it reads.
4. If the brain has nothing that answers it, it is a `no-answer` query with an empty
   `expected`.

Class: `paraphrase` for a question as asked, `no-answer` for one with no answer, and any
other label the user wants for grouping. Give each query a short, stable `id`.

## 3. Lint before writing

Write the candidates to a scratch file, one JSON object per line, and run:

```bash
brain eval --lint --set <scratch file> --json
```

- Exit `2` means the set is malformed; the message names the line. Fix that line and run it
  again.
- Each entry in `warnings` is a `paraphrase` query that shares a word with its answer's title.
  Show them to the user. Keep a question that really was asked that way, since that is how
  they search. Rewrite one only if the user says the wording was not theirs.

## 4. Append and run

Append the linted lines to `evals/retrieval.jsonl` (create it if needed; keep an existing
header line first) only when `--lint` exits `0`. Then offer a run:

```bash
brain eval --mode fts          # keyless
brain eval --mode all          # also vector and hybrid, when an embedding key is set
```

Summarise hit@1 and the oracle row for the user, and name the new queries that missed.
