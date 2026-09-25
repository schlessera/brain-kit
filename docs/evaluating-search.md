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
neither `id` nor `q`. It is reserved for settings that apply to the whole set.
This version understands no header keys yet, so a header that names one is
refused rather than silently ignored.

A line that is not valid JSON, misses a field, carries an unknown field, or
repeats an `id` is a usage error (exit `1`) that names the line number.

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
  length, is named in `warnings`. A query matches as whole words, ignoring case
and spacing, so "cat" never matches "concatenate". `--strict` turns
  that into a refusal (exit `2`).
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
| an expected path does not exist in the brain, leads out of it, or is not a regular file | a typo, or a moved or deleted document, would score as a permanent miss, and a directory is never a search result |
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
  retrieved and then ranked below something else. Ranking changes (the reranker,
  fusion, the title boost) can fix it.
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

Scores are only comparable within one mode: full-text scores are BM25 values,
hybrid scores are fusion values in the hundredths.

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
only run in your own brain, with your own keys. brain-kit's CI runs the
full-text lane only.
