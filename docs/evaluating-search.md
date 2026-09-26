# Evaluating search

`brain eval` scores a set of queries against the brain it runs in. You write down
questions you actually ask and the documents that answer them. The command runs
each question through the same search `brain search` uses and reports how often
a right document came first.

It answers "how well does search find things in *my* brain", with the package
version you have installed. You can run it before and after an upgrade or a
configuration change and compare the two runs.

```sh
brain eval --mode fts                 # keyless: the full-text lane only
brain eval --mode hybrid              # full-text + vectors (needs an embedding key)
brain eval --mode all --out evals/run.json
```

## The query set

The default set is `evals/retrieval.jsonl` at the brain root; `--set <file>`
points at another (a relative path is relative to the brain root). It is JSON Lines: one JSON object per line, one query per
object, with its right answers inline.

```jsonl
{"id": "scope-setup", "q": "how is the telescope set up", "class": "question", "expected": ["studies/telescope-setup.md"]}
{"id": "dob", "q": "the Dobsonian", "class": "alias", "expected": ["studies/telescope-setup.md"]}
{"id": "bookshelf-status", "q": "bookshelf status", "class": "ambiguous-filename", "expected": ["projects/active/bookshelf/status.md"]}
{"id": "bio", "q": "short bio", "class": "exact", "expected": ["me/basics/short-bio.md", "me/basics/long-bio.md"]}
{"id": "tax", "q": "tax return deadline", "class": "no-answer", "expected": []}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A stable name for the query. Unique within the set. A later comparison between runs matches queries by it. |
| `q` | yes | The query text, exactly as you would type it. |
| `class` | yes | A free-form label: `exact`, `alias`, `question`, whatever groups your queries usefully. Every class gets its own score row. |
| `expected` | yes | Paths relative to the brain root. Any one of them in a position counts as a hit there. |
| `lang` | no | A language tag, for your own grouping. It does not change how the query runs. |

An empty `expected` is allowed only with `class: "no-answer"`, and a `no-answer`
query must have an empty `expected`. It marks a question the brain should have
nothing for (see [No-answer queries](#no-answer-queries)).

Blank lines are skipped. The first line may instead be a header object, one with
neither `id` nor `q`. Its only key is `now` (see [Answers that depend on the
date](#answers-that-depend-on-the-date)). Any other key is refused rather than
silently ignored.

A line that is not valid JSON, misses a field, carries an unknown field, or
repeats an `id` is a usage error that names the line number. Under `brain eval`
a usage error exits `2`, like a refused run, so exit `1` is kept for a failed
`--baseline` gate.

### Answers that depend on the date

"What is due next" has a right answer that changes over time. A fixed path in
`expected` freezes it on the day you wrote the query. Give a selector instead,
and the answer is worked out from frontmatter at every run:

```jsonl
{"now": "2026-07-12"}
{"id": "due-next", "q": "what is due next", "class": "time", "expect": {"select": {"field": "deadline", "after": "now", "order": "asc", "take": 1}}}
{"id": "reviews", "q": "what should I review", "class": "time", "expect": {"select": {"type": "context", "field": "next_review", "after": "now", "order": "asc", "take": 2}}}
```

| Selector key | Meaning |
| --- | --- |
| `field` | A frontmatter date field (`deadline`, `next_review`, `updated`, …). A document without a readable date there, or with a day that does not exist (`2026-02-30`), is never selected. |
| `type` | Only documents of this frontmatter `type`. Optional. |
| `after` / `before` | `"now"` or an ISO date; the field must lie strictly after or before it. At most one, or neither. |
| `order`, `take` | Sort by the field, `"asc"` (soonest first) or `"desc"`, and keep the first `take`. Ties sort by path. |

The selector reads the markdown files the index covers, not `brain.db`, and
skips any the indexer skips (no `title` or `type`): such a document can never
be a search result, so it must not take one of the `take` slots. The
paths it picks become that query's `expected` for the run, and `per_query`
prints them. **A selector that selects nothing refuses the run** (exit `2`):
the query would have no right answer to score.

`now` comes from the header, then from `--now <ISO date>`, then from the wall
clock. The header wins over the flag, because a date-dependent set is only
reproducible at the date it was written for; the run then says in `warnings`
that `--now` was ignored. The same `now` is what search measures recency from,
so a pinned set ranks the same way on any day. `meta.now` records it.

### Stale versus current

When a newer document supersedes an older one (a bio regenerated from its
facts file, an archived build), you want search to prefer the current one. Add
the superseded paths as `stale`:

```jsonl
{"id": "bio", "q": "short bio", "class": "stale-vs-current", "expected": ["me/basics/FACTS.md"], "stale": ["me/basics/short-bio.md"]}
```

Such a query counts toward its class's **current first** rate. It is current
first when its first expected path ranks above every stale path, or when no
stale path is in the top max(k) at all. The rate is `null` for a class with no
`stale` queries. Stale paths are checked like expected ones: they must exist,
be files and be indexed.

### Writing a useful set

- **Use queries you actually ask.** A set made of document titles measures title
  matching. Take them from your shell history, your chat sessions, the moments
  search let you down.
- **Judge by path, not by feel.** List every document that answers the query in
  `expected`. A document you forgot to list scores as a miss when it comes first.
- **Keep the set out of your notes.** A markdown note that quotes the queries is
  a perfect answer to all of them, and the eval ends up grading itself. The
  top-level `evals/` directory is never indexed, so the set, results saved with
  `--out`, and any notes about them are safe there. Elsewhere, `brain eval`
  checks every indexed document before scoring. A document that contains one
  of the set's queries of four or more words, or three of its queries of any
  length, is named in `warnings`. A query does not count against the
  documents it expects: an exact-title or alias query quotes its own answer. A query matches as whole words, ignoring case
and spacing, so "cat" never matches "concatenate". `--strict` turns
  that into a refusal (exit `2`).
- **Mark questions as asked with `class: "paraphrase"`, and lint them.** A
  query worded while looking at its answer borrows the answer's title words.
  `brain eval --lint` reports each `paraphrase` query that shares a content word
  (stopwords dropped, ignoring case and accents as keyword search does) with the
  title of one of its `expected` documents. It names the words and the path in `warnings`, and
  exits `0`. It validates the set too (a malformed line exits `2` and names the
  line), and it never opens the index, so it runs in a brain that has not been
  indexed. The `brain-eval` skill collects real questions from a session and an
  interview, lints the set they would produce (existing queries included), and
  writes it only when that passes.
- **Twenty to fifty queries is enough to start.** Each query moves hit@1 by
  1/n. With 25 queries one query is 4 points, so read a small change as a
  change in specific queries, not as a trend.

## Validity gates

A run that cannot be measured refuses to score and exits `2`. It prints the
reason on stderr, and nothing on stdout. It does not write `--out` either. A
number from a broken run would be read as a real result.

| Refused when | Why |
| --- | --- |
| the set is missing or has no queries | there is nothing to measure |
| a selector selects no document | the query has no right answer at this `now` |
| an expected or stale path does not exist in the brain, leads out of it, or is not a regular file | a typo, or a moved or deleted document, would score as a permanent miss, and a directory is never a search result |
| an expected path exists but is not in the index | an excluded directory, or a file without `title`/`type`, can never be found |
| the index is older than the markdown | a document changed, appeared or went away since the last `brain index`, so the run would score yesterday's brain. Run `brain index` and try again. An indexed file that cannot be read refuses too, since its freshness cannot be checked |
| a requested lane degraded | `--mode vector` or `--mode hybrid` with no embedding provider, a model mismatch, a timeout. The run never scores the full-text fallback under the vector lane's name |

## Reading the result

```
brain eval — 5 queries, 25 documents, now 2026-07-12T09:00:00.000Z

mode  class               n  hit@1   hit@3   hit@10  MRR@10  oracle  top1 median
fts   (all answerable)    4  75.0%   100.0%  100.0%  0.875   100.0%  3.84
fts   question            1  0.0%    100.0%  100.0%  0.500   100.0%  2.10
fts   alias               1  100.0%  100.0%  100.0%  1.000   100.0%  4.02
...
fts   no-answer           1  -       -       -       -       -       1.37
```

Each mode gets an overall row over every answerable query, then one row per
class. `n` is the number of queries behind the row.

- **hit@k** is the share of queries with an expected path among the first k
  results. It is not recall: a query with three expected paths scores a hit
  when any one of them is in the top k. `--k 1,3,10` is the default; a cutoff
  can be at most 1000.
- **MRR@10** is the mean of 1/rank of the first expected path, counting 0 when
  it is below rank 10. It rewards rank 2 over rank 9, which hit@k cannot.
- **oracle** is the share of queries with an expected path anywhere in the
  results the run fetched. Each query fetches 20 results, the `brain search`
  default, or more when a k is larger.

### hit@1 against the oracle

Read the two together. They separate the two ways search fails.

- **A low hit@1 with a high oracle is a ranking miss.** The right document was
  retrieved and then ranked below something else. Ranking changes (the reranker's
  lifecycle factors, fusion) can fix it.
- **A low oracle is a recall miss.** The right document never came back, so no
  ranking change can promote it. Look at the words: the query may not share a
  term with the document (full-text), or the document is not embedded
  (vectors). The vector lane, or wording the document the way you ask for
  it, is the fix there.

### No-answer queries

A `no-answer` query is never scored as a hit or a miss. Its row reports the
median top-1 score instead, and the overall row beside it reports the same
median for the answerable queries. When the two are close, search answers an
unanswerable question as confidently as a real one. That is the case where an
agent reading the top result is most likely to be misled.

Scores are only comparable within one mode and one rerank setting:

| Mode | `--rerank none` | `--rerank heuristic` (the default) |
| --- | --- | --- |
| `fts` | the BM25 value, larger is better | BM25 times the lifecycle factors |
| `hybrid` | the fusion value, in the hundredths | fusion times the lifecycle factors |
| `vector` | the similarity `1 / (1 + distance)` | `1 / (60 + rank)` times the lifecycle factors |

The lifecycle factors are relevance (`primary` ×1.15, `historical` ×0.85),
draft status (×0.9), a `generated_from` document (×0.85) and recency (between
×0.7 and ×1).

With the heuristic reranker, a vector score comes from the result's rank, not
its distance. Rank 1 starts at `1/61` whether the nearest vector was close or
far, so the median top-1 score cannot tell a confident vector answer from a
weak one. To compare confidence in vector mode, run it with `--rerank none`,
which keeps the distance.

## Measuring `brain context`

`brain context` is what an agent is handed: the identity and current-focus
documents, then search hits, within a token budget. `--context` runs every
query through it at each budget (`--budgets 1000,4000,8000` is the default),
and reports per budget:

- **answer present**: the share of answerable queries whose expected path the
  assembler included as a search hit, or as the identity or focus document
  (shown in full or in part). A document only named in the Related list does
  not count. Give a query an `answer` string to look for that text
  instead, when the right answer is a fact rather than a document.
- **budget used**: how much of the budget the output takes, by the
  assembler's own token estimate, as the median, p10 and p90 over all
  queries. A budget used to the brim with the answer still missing is spent
  on the wrong things; one barely used means more budget buys nothing.

```sh
brain eval --mode fts --context --budgets 500,1000,4000
```

Read the rows as a curve: the budget at which the answer-present rate stops
rising is the most your agents need to be given for this set.

## Comparing against a baseline

Store a run, then compare later runs against it, query by query:

```sh
brain eval --mode fts --out evals/baseline.json     # once, before the change
brain eval --mode fts --baseline evals/baseline.json
```

The report lists which queries were **lost** (a hit before, a miss now),
**gained** and **unchanged**, at each k and per class. With a few dozen queries,
one flip moves hit@1 by several points, so the gate counts queries instead: it
fails (exit `1`) when the net loss on hit@1 reaches `--max-net-loss` (default 2),
or when any query in a `--must-pass` class is lost. The exact sign-test p over
the flipped queries is printed as information. With few flips it has little
power: three lost and one gained is p = 0.625, although six lost and none
gained is already p = 0.031. The list of IDs says more than the number.

Runs that measured different things are **not comparable** (exit `3`, which is
not a pass): a different mode, embedding model or `--k`, or a changed query
set. After editing the set on purpose, `--allow-set-change` compares the
queries both runs share. `brain doctor` reminds you to rerun the comparison
when `evals/baseline.json` was recorded with another version. Nothing runs on
install or upgrade.

`--redact` leaves the query text and every path out of the output and of
`--out`, keeping IDs, classes and the numbers, so a result can be shared
without sharing the brain. A refused run keeps its reason and withholds the
list of documents behind it. The one thing `--redact` does not withhold is a
path you typed yourself: an error about a missing `--set`, `--baseline` or
`--out` repeats it.

## Output

`--json` prints the envelope described in the
[integration contract](integration-contract.md#brain-eval---json); `--out <file>`
also writes it to a file, which must be inside the brain: a path that leads
out, directly or through a symlink, is refused before the run starts. Without
`--out` nothing is written. The `meta` block
records what the run measured: the installed version (and the source directory
when it runs from a checkout), the set file and its SHA-256, the number of
indexed documents, the embedding model when a vector lane ran, the modes, the
reranker, the cutoffs, and `now`, the instant recency ranking was measured
from.

Keyed lanes (vector, hybrid) cost one query embedding per query and mode. They
only run in your own brain, with your own keys. brain-kit's CI scores the
full-text lane on real text, and runs the hybrid lane only with hand-staged
vectors that test how the lanes are fused, never how good embeddings are.
