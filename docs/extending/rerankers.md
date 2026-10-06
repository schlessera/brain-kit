# Extending: rerankers

The `Reranker` seam orders a query's candidates by relevance judgment. Inside
`hybridSearch` it runs after full-text/vector fusion and before truncation, so
it sees the pool the engine retrieved. It is also the piece a search that fans
out over several sources ranks the *union* with — once, not per source.

It is what `rerank: "jev"` means. The other two rerank modes are not rerankers:
`heuristic` multiplies the retrieval order by the lifecycle factors
(relevance, draft, recency, `generated_from`), and `none` leaves it alone.

## The interface

From `@schlessera/brain` (`src/lib/seams.ts`):

```ts
export interface RerankCandidate {
  id: string;            // stable within its source: a brain path, a record id
  source?: string;       // "brain", "calendar", … — source + id is the identity
  title: string;
  type?: string;
  tags?: string | null;
  summary?: string | null;
  excerpt?: string;      // the passage the retriever matched
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  score?: number;        // retrieval score, for rerankers that nudge
}

export interface RerankRequest<C extends RerankCandidate = RerankCandidate> {
  query: string;
  candidates: readonly C[];   // retrieval order
  mode?: SearchMode;          // "fts" | "vector" | "hybrid"; absent for a union
  signal?: AbortSignal;       // the caller's deadline
}

export interface Ranked<C> { item: C; score: number }

export interface Reranker {
  id: string;                                    // e.g. "jev:jev-1.13.0"
  capabilities: { modes: readonly SearchMode[]; network: boolean };
  rerank<C extends RerankCandidate>(req: RerankRequest<C>): Promise<Ranked<C>[]>;
  preview?<C extends RerankCandidate>(req: Omit<RerankRequest<C>, "signal">): unknown;
}
```

The contract, in order of what matters:

- **Return every candidate exactly once, by reference.** The caller's own
  objects come back inside `Ranked.item`, so whatever a fan-out attached to a
  candidate (its origin, a record handle) survives the round trip. `source` +
  `id` is the identity; `assertPermutation` enforces it, and a violation
  counts as a failed call.
- **Failure is a degraded mode.** Throwing, or missing the caller's deadline,
  leaves the retrieval order in place with a `warnings` entry. It never fails
  the search. The built-in `jev` makes one attempt per search for the same
  reason: a retry inside an interactive deadline only delays the fallback.
- **`attributes` are evidence.** A brain passes each document's `status`,
  `relevance` and `updated`, so the judgment can weigh a draft or a historical
  document as one. The engine does not multiply the judged order by the
  lifecycle factors afterwards; see the measurements below for why.
- **`capabilities.modes`** names the lanes the reranker serves. Search skips
  it on the others without a warning.
- **`capabilities.network: true`** means candidates leave the machine. The
  engine then withholds every path matched by `reranker.exclude` and re-merges
  it at its retrieval rank; the reranker never sees it. The query text itself
  is always sent — relevance cannot be judged without it.
- **`preview`** returns the exact outbound request without sending it. It backs
  `brain search --rerank-dry-run`, which prints the request to stderr.

The contract suite is `runRerankerContract` in `@schlessera/brain/testing`;
`packages/core/tests/seam-contracts.test.ts` runs the built-in through it.

## Nullable tags migration

The approved pre-1.0 breaking minor in #702 corrects the public declaration:
brain candidates have a comma-separated tag string or `null` when untagged.
Candidates from other sources may still omit `tags`. External providers must
handle both absence and null before string operations, for example
`const tags = candidate.tags ?? ""` when building text. Keep the candidate
object itself unchanged when returning it by reference.

`SearchResult.tags` likewise declares `string | null`; module and library
consumers can use `result.tags ?? ""` for local display text. This changes
TypeScript checking, while existing retrieval JSON and reranker inputs stay
the same. The built-in Jev provider already clips absent/null tags to empty
outbound text, so its request values and ranking are unchanged.

## Built-ins

| Name  | What it does                                                    | Key                |
| ----- | --------------------------------------------------------------- | ------------------ |
| `jev` | One TypeSafe System One Choice over the candidate ids (opt-in provider) | `TYPESAFE_API_KEY` |

The explicit activation policy below is available in 0.40.0+; published
0.39.0 does not have `reranker.enabled`.

Judgment providers require `reranker.enabled: true`; omitted or false keeps
search on local `heuristic` ordering (or `none` when selected), even with a key
or custom provider. `jev` is the default provider once enabled. It also needs
its key; an explicit `--rerank jev` or `BRAIN_RERANK_MODE=jev` while disabled or
keyless falls back with a warning. Eval refuses to score that fallback.
`--rerank-dry-run` can inspect the request while disabled or keyless and sends
nothing. See [the config migration](../configuration.md#reranker) and the
[activation decision](../decisions/reranker-activation.md).

```ts
reranker: {
  enabled: true,                    // only this setting activates judgment
  provider: "jev",                  // or "heuristic", "none", or a Reranker value
  model: "jev-1.13.0",              // pinned; jev-latest moves, and brain doctor warns on it
  apiKeyEnv: "TYPESAFE_API_KEY",
  exclude: ["career", "clients/**/ledger.md"],  // never transmitted
  timeoutMs: 3000,                  // past this, retrieval order stands
  depth: 50,                        // judge the top N; the rest follow in order
  // skipMargin: 0.02,              // opt-in cost lever, see below
}
```

### What jev sends

Per candidate: `title`, `type`, `tags`, `summary` (at most 300 characters),
`excerpt` (at most 400, the retrieval snippet with full-text markers
stripped), up to eight attributes (at most 100 characters each), and `source`
when the pool spans several stores. No paths, no scores, no document bodies.
The question names the situation and warns against index and registry pages;
nothing more. A Choice takes at most 255 options; past that, the rest stays in
retrieval order behind the judged block.

## Measurements

Measured with `brain eval --mode all` on a 1,133-document brain, `gemini-embedding-2`,
pool 20, `career/`, `private/` and `clients/` excluded from the reranker. Two
query sets: 27 hand-written questions (the reported set) and 83 written
against a stratified document sample (the development set). hit@1:

| Rerank                                   | hand, vector | hand, hybrid | dev, vector | dev, hybrid |
| ---------------------------------------- | -----------: | -----------: | ----------: | ----------: |
| `none`                                   | 0.667        | 0.556        | 0.711       | 0.675       |
| `heuristic`                              | 0.296        | 0.407        | 0.410       | 0.494       |
| jev, then the lifecycle multipliers      | 0.444        | 0.556        | 0.458       | 0.506       |
| jev, lifecycle fields as evidence (**shipped**) | **0.852** | **0.741** | **0.783** | **0.807** |

The shipped row is a run of the released code; the experiment runs behind the
other jev rows scored within one or two queries of it, which is the run-to-run
spread of the judgment. Read single-query differences as noise.

Two findings decided the design:

- **The lifecycle multipliers cannot follow a judgment.** On the rank-derived
  scale `1 / (60 + rank)` adjacent ranks differ by under 2%, so a ×0.85 factor
  moves a result about ten places. Applied after jev, they undid most of its
  gain; recency alone accounts for most of the damage (the same factors hurt
  the `heuristic` mode on this brain too). Given to the judgment as evidence
  instead, they cost nothing on the vector lane and helped on hybrid.
- **A vector-margin gate is a cost lever, not a quality one.** Skipping the
  judgment where the vector lane's top result already leads by the median
  margin halves the calls; it gained one development query and lost one hand
  query on the vector lane, and lost two to five queries on hybrid. Hence
  `skipMargin` is off by default.

What was tried earlier and lost, so it is not re-added without a new
measurement: pairwise judgments per candidate (worse at 30× the calls), a
second pass over a shortlist with document bodies, decomposed sub-judgments,
type-first routing (a wrong filter removes the answer for good), document
heads instead of the retrieval excerpt, fusing the judged order with the
retrieval order, and a local cross-encoder (bge-reranker-base scored at or
below the unreranked vector lane).

Measure your own brain before trusting any of this: `brain eval --rerank
heuristic` against `brain eval --rerank jev`, with `--baseline` to see which
queries moved.

## Add your own (≤3 steps)

1. **Implement `Reranker`** — via the typed helper:

   ```ts
   // my-reranker.ts
   import { defineReranker } from "@schlessera/brain";

   export const myReranker = defineReranker({
     id: "mine:rerank-v1",
     capabilities: { modes: ["fts", "vector", "hybrid"], network: true },
     async rerank({ query, candidates, signal }) {
       const res = await fetch("https://rerank.example.com/v1/rerank", {
         method: "POST",
         signal,
         body: JSON.stringify({
           query,
           documents: candidates.map((c) => `${c.title}\n${c.summary ?? ""}\n${c.excerpt ?? ""}`),
         }),
       });
       const { results } = (await res.json()) as { results: { index: number; score: number }[] };
       return results.map((r) => ({ item: candidates[r.index], score: r.score }));
     },
   });
   ```

2. **Reference it by value:**

   ```ts
   import { defineConfig } from "@schlessera/brain";
   import { myReranker } from "./my-reranker";

   export default defineConfig({
     reranker: { enabled: true, provider: myReranker, exclude: ["career"] },
   });
   ```

3. **(Optional) publish** it as `brain-reranker-<vendor>`, with
   `runRerankerContract` in its tests.

A custom value is used as-is: key handling and availability are its own
business, after the same persistent opt-in as the built-in. `brain search
--rerank jev` still names the built-in when you want to compare.

`resolveReranker` only constructs a provider; it does not activate search.
The engine's own search path (`hybridSearch`, reached by first-party code
through the unsupported `@schlessera/brain/internal` entry) requires the
persistent opt-in alongside the provider; passing a provider or requesting
`jev` alone leaves judgment off. A preview callback may inspect the request
while off, without a call.

## Reranking a fan-out

When several sources answer one query, call each with `rerank: "none"` and a
deep limit, tag every candidate with its `source`, and rerank the union once.
Honor the same activation setting before calling a judgment over that union.
Per-source reranking and then fusing is not comparable: a Choice's
probabilities normalise within one call, so a mediocre candidate from a weak
pool outranks a good one from a strong pool. The helpers the engine's own
search uses are public for exactly this — `partitionForRerank`, `mergeWithheld`,
`assertPermutation`, `buildPathMatcher` and `candidateKey`.

## See also

- [embeddings.md](embeddings.md) — the vectorizer whose candidates get reranked.
- [README.md](README.md) — the seam meta-mechanism and degradation model.
- [../configuration.md](../configuration.md#reranker) — the `reranker` config key.
- [../evaluating-search.md](../evaluating-search.md) — measuring it on your brain.
