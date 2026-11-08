# Product-path propagation policy diagnostic

Run only explicitly, outside ordinary CI:

```sh
bun evals/3452-propagation-policy/run.ts --run --max-usd 1
# Offline recomputation from the recorded answers, with no provider calls:
bun evals/3452-propagation-policy/run.ts --summary
```

It refuses to overwrite results. The output records full fictional requests,
typed provider responses, product dry-run outcomes and preset summaries. It
never writes an acknowledgement or edits a source/derivative document. Provider
credentials come only from the environment and are never recorded. A UTF-8
input-byte reservation bounds each HTTP attempt, including retries, under the
specified cap; this is not invoice accounting or a cost comparison.

This is the same independently reviewed authored corpus as #3445, reused for
the additional questions and user-policy diagnostic. There is no new blind
hold-out. All three questions are asked in one request against the same complete
state; the main question is unchanged. Structural prerequisites (known scope,
available regular historical sources, exact recorded derivative or explicit
reference) are applied by product code before any request. Presets were declared
before the run and are compared without choosing a new floor from held-out.
The maintainer selected balanced as the shipped default on 2026-11-08, after
this diagnostic. The recorded presets and observations are unchanged.

Every available case runs three repetitions. Missing history/scope remains an
unavailable product outcome, not a guessed label. Golds are used for scoring
only and are never in the provider request. The product policy function scores
both primary-only and additional-veto policies; it never averages confidence.
Primary-only numbers discard the extra answers from the same three-question
request. They are a gate replay, not a separate live one-question arm; changing
the question bundle could also change the primary answer.
Results and limits are in [the decision](../../docs/decisions/propagation-triage.md#user-selected-confidence-and-cross-checks).
