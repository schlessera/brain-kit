# Bounded production triage

The concrete UI-server triage engine implements T0 and T1 routing for #680.
The server's drain does not invoke it yet: #689 owns production dispatch and
the complete autonomous system gate. Triage never applies a knowledge-base
write, selects a backend profile, or grants an operation. Markdown remains
content authority. Routing receipts and checkpoints use the existing UI
operational store and its backup/recovery path.

## Routing and evidence

T0 reuses intake's committed SHA-256 receipts. A byte-identical arrival from
the same source/principal is a duplicate even when authenticated CLI intake
used another explicit key. Keys alone are not hashes. Empty evidence drops
without inference; damaged or missing staging creates a durable review Action.

T1 uses the [ordered eval rubric](../packages/ui-server/evals/triage/prompt.txt):
first a human blocker now, then work an agent can start, and finally text-only
durable value. The last step cannot erase an obligation or infer existing
knowledge-base content. Routing has four values: `drop`, `rule`, `needs_agent`
and `needs_user`.

The [classifier decision](decisions/triage-classifier.md) selects
`jev-1.13.0`, one four-way Choice per item. Both confidence and chosen-route
probability must be at least 0.4. Malformed/unknown results retry once alone;
an unanswered retry becomes a durable review Action. Valid sibling answers
survive a malformed entry. Low-probability answers go straight to review.
Every requested ID gets a persisted result or retains recoverable queued work.

Serialized evidence is bounded to 4,000 UTF-8 bytes per item. Requests include
the rubric and question overhead within 40,000 bytes, and state plus the
longest question within 32,000 bytes. Bytes conservatively overcount input
tokens; no tokenizer ratio is assumed. A batch has at most eight items, the
largest measured shape approved by the decision. The byte budgets can split
it sooner. A clipped item always escalates because a buried obligation may
be outside the retained prefix.

Staging reads use bounded non-symlink file handles. Text attachments and
already validated structured extraction (such as track summaries) share the
same final evidence bound. Unsupported binary attachments require the agent
tier; a `drop`/`rule` answer cannot discard their unexamined contents. T1
performs no unaccounted OCR, vision, fetching or summary generation.

Accepted `rule` and `needs_agent` results remain ready with a routing receipt
for the dispatcher. `rule` means routing, not permission to file. `drop`
terminates the triage item. `needs_user` atomically parks work behind an
existing durable Action with a cancellation option; the dispatcher owns any
later bounded execution or application choices. Model output cannot change
trust, principal, priority, paths, tools or profile.

## Transport and accounting

The engine reuses the existing classification key (`TYPESAFE_API_KEY`), Jev
client and model-pricing service. It creates no AgentBackend or provider seam.
The direct TypeSafe request is API billed; it is never subscription billed.
Each physical request, including a transport retry or an individual missing-ID
retry, acquires its own conservative reservation and autonomous turn count.
An in-flight lifetime lock protects settlement until the actual request drains.

HTTP 429 and 5xx retry at most twice, after 250 ms and 500 ms, with a fresh
reservation before each attempt. Exhaustion records a transport gap and
escalates; it is not a model misrouting score. Each request has the existing
two-second deadline and forwards cancellation. Empty input, a missing key or
refused first admission creates neither inference nor an Activity run.

The response must identify the pinned model and carry nonnegative integer
input/output usage. Missing receipts fail closed and retain conservative
charges through the [budget ledger](inbox-budget.md). Unresolvable paid pricing
refuses before inference and raises the existing suppressed pricing Action.
The bundled price is an estimate, never an invoice or a claim of zero dollars:
input $0.042 per million, output free, cache adjustments unknown. The vendor's
[model documentation](https://docs.typesafe.ai/models) and
[API reference](https://docs.typesafe.ai/api) were checked on 2026-10-10 for
the pin, text-only input, context limits, price and usage shape.

## Evidence for retaining T1

Each persisted item records tier, route, proposed route, refusal/fallback
reason and its accounting run IDs. Activity records actual input/output
tokens, effective cost with the pricing-estimate flag, outcome and latency
per physical call. Shared batch costs are counted once. Later server-observed
route contradictions append audit checkpoints; they cannot change authority.
Recovery of transport/accounting gaps is counted separately from contradictions
of an answered route; an outage is never scored as a model misroute.
The summary reports T2 fraction against the direct-to-T2 routing baseline
(100%), effective cost and unpriced calls. This routing baseline is a
counterfactual, not a measured cost comparison.

Retain T1 only with a matched completed-item comparison showing meaningful
diversion or smaller T2 context and lower total cost per completed item,
including classification retries, extraction, summaries and downstream T2
work. Apply the existing eval gate independently to each full repetition and
held-out set: no lost rows, missed escalations or obeyed injections, with the
existing filing/agent accuracy floors. Transport gaps remain unjudged evidence.
Unknown cost cannot establish savings. Production cost comparisons require
separately authorized evidence once the dispatcher exists; this integration
does not run a paid experiment or claim such a measurement.

The historical luna/high and Sonnet-4-6/low candidates remain evidence only.
They require current availability, effort, pricing and separately authorized
gate evidence before enablement. The known Sonnet-5 gate failure remains in
the design and eval reports. No generative candidate is enabled by this change.
