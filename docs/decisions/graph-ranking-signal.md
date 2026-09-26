# The link graph is not a ranking signal (2026-09-26)

Search ranks on text and vectors alone. The index already computes in-degree,
PageRank and root distance for every document (`computeMetrics`,
`packages/core/src/lib/graph/metrics.ts:59-110`), but only for the drawn graph.
The question behind #419 is whether a graph signal should also move search
results, and in particular whether a document one link away from the
current-focus document should rank higher.

**Decision: no graph signal in ranking.** Linked neighbours reach an agent
through `brain context`, which spends leftover budget on the top hits'
neighbours (#418), not through the ranking itself. This was the maintainer's
ruling before the measurement. The measurement below was taken so the
question does not come back without evidence, and it agrees with the ruling.

## What was measured

`scripts/measure-graph-boost.ts` reruns the keyless retrieval goldens:
`packages/core/fixtures/corpus/evals/retrieval.jsonl`, full-text lane,
heuristic reranker, clock pinned to the set's `now` (2026-07-12). It then
re-ranks each result list with a multiplicative boost on the documents one
link away from `context/current-focus.md`, in either direction (`boost`,
`scripts/measure-graph-boost.ts:60-65`). The boost multiplies the final
score, after the reranker, which is where a shipped boost would sit; placed
there it would apply the same way in every mode. The script refuses to report
unless its unboosted baseline reproduces `evals/expected-ranks.json` exactly:
the same query IDs, and every pinned field (rank, `current_first`, the
no-answer `top`), checked as the golden test checks them. So the baseline is
the goldens' own ranking.

The set gained a `current-state` class for this: three queries whose answer is
one of the focus document's links.

| id | query | answer | baseline rank |
| --- | --- | --- | --- |
| `current-state-face-frame` | walnut face frame joinery | `projects/active/bookshelf/plan.md` | 1 |
| `current-state-scope-case` | telescope case dimensions | `studies/telescope-setup.md` | 2 |
| `current-state-rehab` | range-of-motion progress | `health/knee-injury.md` | 1 |

Two neighbour sets were boosted at ×1.1, ×1.25, ×1.5 and ×2:

- **one-hop**: every document linked to or from the focus document, which is
  `_index.md`, `health/knee-injury.md`, `me/identity.md`,
  `projects/active/bookshelf/_index.md`, `projects/active/bookshelf/plan.md` and
  `studies/telescope-setup.md`;
- **one-hop, no `_index.md`**: the same without directory anchors. This is the
  one-hop form of the third option below, which drops structural links from
  the ranking graph.

hit@1 / MRR@10, 23 answerable queries (the no-answer query is not scored):

| class | n | baseline | one-hop ×1.1 | ×1.25 | ×1.5 | ×2 | no `_index.md` ×1.1 | ×1.25 | ×1.5 | ×2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 23 | 0.696 / 0.809 | 0.652 / 0.788 | 0.696 / 0.806 | 0.696 / 0.806 | 0.609 / 0.757 | 0.696 / 0.809 | 0.739 / 0.831 | 0.739 / 0.831 | 0.739 / 0.831 |
| exact | 2 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| question | 2 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| paraphrase | 2 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 |
| alias | 3 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| ambiguous-filename | 2 | 1.000 / 1.000 | 0.500 / 0.750 | 0.500 / 0.750 | 0.500 / 0.750 | 0.000 / 0.500 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| time | 2 | 0.500 / 0.667 | 0.500 / 0.667 | 0.500 / 0.625 | 0.500 / 0.625 | 0.000 / 0.375 | 0.500 / 0.667 | 0.500 / 0.667 | 0.500 / 0.667 | 0.500 / 0.667 |
| stale-vs-current | 2 | 0.500 / 0.625 | 0.500 / 0.625 | 0.500 / 0.625 | 0.500 / 0.625 | 0.500 / 0.600 | 0.500 / 0.625 | 0.500 / 0.625 | 0.500 / 0.625 | 0.500 / 0.625 |
| multi-hop | 2 | 0.000 / 0.350 | 0.000 / 0.350 | 0.500 / 0.600 | 0.500 / 0.600 | 0.500 / 0.600 | 0.000 / 0.350 | 0.500 / 0.600 | 0.500 / 0.600 | 0.500 / 0.600 |
| non-english | 2 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| recency | 1 | 0.000 / 0.333 | 0.000 / 0.333 | 0.000 / 0.333 | 0.000 / 0.333 | 0.000 / 0.250 | 0.000 / 0.333 | 0.000 / 0.333 | 0.000 / 0.333 | 0.000 / 0.333 |
| current-state | 3 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 | 0.667 / 0.833 |

Ranks that moved, baseline → boosted:

- **one-hop ×1.1:** `filename-bookshelf` 1→2.
- **one-hop ×1.25 and ×1.5:** `filename-bookshelf` 1→2, `time-review` 3→4, `multi-hop-collimate` 2→1.
- **one-hop ×2:** `filename-bookshelf` 1→2, `filename-signage` 1→2, `time-due-next` 1→2, `time-review` 3→4, `stale-bio` 4→5, `multi-hop-collimate` 2→1, `recency-rehab` 3→4.
- **no `_index.md` ×1.1:** nothing moved.
- **no `_index.md` ×1.25, ×1.5 and ×2:** `multi-hop-collimate` 2→1.

## What it says

- **The boost does nothing for the class it was meant to help.**
  `current-state` is unchanged at every factor, in both sets. Two of its three
  answers already rank first. The third, `telescope-setup.md`, loses to
  `projects/active/bookshelf/plan.md`, which is also a neighbour of the focus
  document, so a boost on neighbours lifts both and leaves their order alone.
  That is the general shape: the documents a current-state question competes
  among are usually all linked from the focus document, because that is what
  "current" means.
- **Boosting every neighbour rewards structural hubs.** The regression at
  every factor is `filename-bookshelf` ("bookshelf status"). There the boost
  lifts `projects/active/bookshelf/_index.md` above the `status.md` the query
  names, because the focus document links the directory. At ×2 it also pushes
  the same index above the right answer for `filename-signage`,
  `time-due-next` and `recency-rehab`. An `_index.md` is linked because it is a
  directory's anchor, not because it is relevant.
- **Without the anchors, the boost is harmless and helps one query.**
  `multi-hop-collimate` ("what should I collimate before the deep-sky session")
  moves from 2 to 1 at ×1.25 and above, and nothing regresses. That is one
  query on a 25-document fixture, which is not enough to ship on, and it is not
  the class the boost was for. `brain context`'s neighbour expansion (#418)
  already puts that neighbour in front of an agent without reordering search
  results.

Since the boost does not win on `current-state`, the issue's condition for a
follow-up task is not met, and none is filed.

## The options

1. **No graph signal (chosen).** Search stays text and vectors. Neighbours
   reach an agent through context assembly (#418), where their cost is visible
   in the budget and they never displace a better text match.
2. **A multiplicative boost on the focus document's one-hop neighbours
   (measured above, rejected).** With directory anchors included, it demotes
   the right answer at every factor tried. With them excluded, it is inert on
   the target class and helps one multi-hop query.
3. **PageRank over a ranking graph without structural links (rejected, not
   built).** The same PageRank the graph view computes, but over a graph that
   drops every link to an `_index.md`. The graph the index builds treats every
   resolved link alike (`loadLinkGraph`, `packages/core/src/lib/graph/build.ts:29-82`),
   so this would need a second graph beside the one the hosted UI reads through
   the `graph_*` tables. That table surface is
   contract-bound and stays unchanged. Global centrality also answers "what is
   important in this brain", not "what is relevant to this query". The
   no-`_index.md` arm above is its closest cheap proxy, and it did not move the
   target class either.

## What would reopen this

A retrieval set from a real, long-lived brain, rather than the 25-document
fixture, where `current-state` questions fail and the right answer is a focus
neighbour that a non-neighbour outranks. Measure it with
`bun scripts/measure-graph-boost.ts` pointed at that set (the script reads the
fixture today; the boost and the scoring are the parts to reuse), and on the
vector and hybrid lanes, which this keyless run could not cover.
