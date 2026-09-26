---
name: brain-eval
description: Use when growing the brain's retrieval query set (`evals/retrieval.jsonl`) from questions that were actually asked, so `brain eval` measures search on real questions rather than ones written while looking at the answer. Also use when the user wants to know whether search finds what they ask for.
compatibility: Requires the brain CLI. Scoring the vector or hybrid lane needs an embedding key; collecting and linting queries does not.
---

# Brain eval — Grow the Query Set from Real Questions

A query written while looking at its answer borrows the answer's words, which flatters
keyword search. The questions worth keeping are the ones someone actually asked. This skill
collects them, pairs each with the documents that answer it, and adds them to the brain's
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

## 3. Lint the whole proposed set

A candidate that is valid on its own can still break the set it joins: an `id` the set
already uses makes the whole file fail to load. So lint what the set would become, not the
candidates alone.

Write a scratch file that is the current `evals/retrieval.jsonl` exactly as it is (its header
line stays first), followed by the candidates, one JSON object per line. If the set does not
exist yet, the scratch file is just the candidates. Then run:

```bash
brain eval --lint --set <scratch file> --json
```

- Exit `2` means the proposed set is malformed; the message names the line. If that line is a
  candidate, fix it (a clashing `id` gets a new one); if it is an existing line, stop and show
  the user, since the set was already broken. Run it again until it exits `0`.
- Each entry in `warnings` is a `paraphrase` query that shares a word with its answer's title.
  Warnings about existing queries were already accepted; show the user the ones about new
  candidates. Keep a question that really was asked that way, since that is how they search.
  Rewrite one only if the user says the wording was not theirs, then lint again.

## 4. Write and run

Only when the last `--lint` of the whole proposed set exits `0`, replace
`evals/retrieval.jsonl` with the scratch file that passed (create `evals/` if needed). Do not
append the candidates separately: that would write something other than what was linted.
Then offer a run:

```bash
brain eval --mode fts          # keyless
brain eval --mode all          # also vector and hybrid, when an embedding key is set
```

Summarise hit@1 and the oracle row for the user, and name the new queries that missed.
