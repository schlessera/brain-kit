# Model reranking requires persistent opt-in

The maintainer's [2026-09-30 ruling on #406](https://github.com/schlessera/brain-kit/issues/406#issuecomment-5906463771)
separates provider configuration from permission to use model judgment.
The existing `Reranker` seam and Jev provider remain; credentials no longer
activate search judgment automatically.

## Why the activation rule changed

A credential says a provider can authenticate. It does not say every search
should send a query and candidates to that provider. Credential-triggered
activation made adding a key for another TypeSafe use change search behavior,
latency and outbound data without a search-specific choice. A custom provider
injected into the engine also activated judgment implicitly.

`reranker.enabled` is the single persistent choice in canonical brain config.
It accepts booleans and defaults to false when omitted. Provider, model,
key-variable, exclusion and bound fields remain configured while off, so an
off/on toggle does not reconstruct settings. A provider may be omitted; an
enabled config then selects Jev.

CLI search/context/process, MCP search/context, eval and backend library
access resolve the same policy through `rerankSetup`. The direct engine also
requires `SearchDeps.rerankerEnabled === true`; passing a provider alone
cannot bypass it. `resolveReranker` remains a constructor for validation and
standalone provider consumers. It does not authorize engine activation.
A library embedding a configured brain forwards the freshly loaded canonical
setting through `rerankSetup`, rather than treating a key as permission.

Mode selection is subordinate to that choice. `--rerank jev`, MCP
`rerank: "jev"` and `BRAIN_RERANK_MODE=jev` cannot turn judgment on. While off,
`heuristic` orders locally, and `none` retains retrieval order. An explicit
model request warns and falls back. Eval refuses to score that fallback,
including requests from the environment and context-budget evaluation:
reporting a heuristic score as a model score would invalidate the comparison.

Preview is allowed while off or keyless because it constructs the outbound
request without transmitting it. Enabled execution retains exclusions,
cancellation, deadlines, depth and margin bounds, permutation validation and
failure warnings. This choice changes activation, not the provider contract
or fusion algorithm.

## Why retain the provider and seam

[PR #572](https://github.com/schlessera/brain-kit/pull/572) measured the released
Jev ordering on a 1,133-document corpus with 27 hand-written and 83 development
queries, pool 20 and `gemini-embedding-2`. The already-published
[measurement table](../extending/rerankers.md#measurements) gives hit@1:

| Ordering | Hand vector | Hand hybrid | Development vector | Development hybrid |
| --- | ---: | ---: | ---: | ---: |
| Retrieval (`none`) | 0.667 | 0.556 | 0.711 | 0.675 |
| Local lifecycle (`heuristic`) | 0.296 | 0.407 | 0.410 | 0.494 |
| Jev with lifecycle fields as evidence | 0.852 | 0.741 | 0.783 | 0.807 |

Those results support keeping judgment available. They do not establish a
universal quality benefit: the corpus, query sets, model and exclusions bound
the claim, and single-query differences fall within the reported variation.
Applying lifecycle multipliers after judgment lost much of the gain, so they
remain evidence to the model rather than a second scoring pass.

This activation change adds no paid evaluation and measures no live latency
or price. One request per eligible search, the timeout and depth bounds, and
the optional vector-margin gate describe its operational limits; they are
not latency or cost measurements. Re-evaluating fusion and budget/quality
tradeoffs remains the separately scoped [#468](https://github.com/schlessera/brain-kit/issues/468).

Keyless tests record provider calls with synthetic credentials and a
non-empty fixture pool. Enabled judgment reverses that pool; disabled search
makes no call, and re-enabling restores the configured order. Independent
removal of the registry or engine activation guard produces an unexpected
request. Removing eval refusal produces a successful fallback score instead
of exit `2`. These prove activation and reporting boundaries, not model
quality. The corpus retrieval goldens continue to measure local ordering.

## Alternatives rejected

- **Keep credential-triggered activation.** It couples authentication for
  several uses to an unrequested search behavior change.
- **Let a per-request mode or environment variable enable judgment.** It
  defeats a persistent off choice and differs across entry points.
- **Remove Jev or replace the seam.** The measured benefit supports keeping
  it available; activation needs a policy gate, not a provider rewrite.
- **Introduce a settings store, UI or live reload.** Canonical config already
  persists the choice. A new store would introduce synchronization and two
  sources of truth without being needed for this change.

## Migration and reload

This is an approved pre-1.0 breaking behavior change and ships in a minor.
To retain the former ordering, add `enabled: true`; an existing provider or
credential by itself now remains dormant. Turn off only that boolean to keep
all provider settings for later reuse. The CLI reloads config on its next
invocation. Running MCP and embedding hosts restart or recreate their context
from freshly loaded config. TypeScript imports are process-cached, so edits
to a TypeScript config require a process restart. No live reload is promised.

See [configuration](../configuration.md#reranker) for examples and
[integration-contract.md](../integration-contract/package-api.md#model-reranker-activation)
for the compatibility behavior.
