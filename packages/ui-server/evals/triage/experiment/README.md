# Bounded T1 triage experiment methods

This is private evaluation preparation for #848 and its decision to #680. The
existing scorer, rubric, donor dataset and benchmark matrix remain unchanged.
No production caller, dependency, public export or permission rule changes.

The 40 prospective inputs are newly authored Odysseus counterfactuals: twenty
reference controls, ten tuning cases and ten held-out cases. Their labels are
provisional. The historical twenty donor fixtures still exercise existing
keyless regression tests; their older scenarios and measured rows are not
renamed into this corpus. Shared rubric, world and abstract task concepts limit
split independence even with disjoint IDs, families and templates. Full semantic
review must address that limitation. The unchanged donor README requires three
strong models from different families and unanimous labels. Its old judge roster
is neither current authorization nor proof of three distinct families.

The experimental adapter uses the actual shipped ui-server Jev client through
its lowest request method. A direct Choice asks for four routes. Ordered Noul
questions ask human-blocker-now, then agent-can-start, then text-only durable
value. Code composes precedence. Choice acceptance needs both confidence and
selected-choice probability; unknowns and low probability escalate operationally
while retaining their quality and raw-coverage consequences. Provisional .8
Choice and .8/.2 Noul floors are transport controls, not calibrated adoption
thresholds. Tune only tuning inputs, then freeze before held-out scoring.

Per-item and batches of eight run three scripted repetitions each. These twelve
author-scripted repetitions prove mechanics only. Each repetition and the
held-out split separately retain the unchanged hard gates: no missed human,
lost row or injection obedience; filing and agent accuracy at least 90%; complete
raw judgment coverage. Successful malformed answers followed by unavailable
recovery retain lost-row failures. A pure transport gap has no quality judgment
and cannot pass coverage. Missing same-type answers recover only their own item,
once. The shipped client's wrong answer type poisons its whole answer map; this
experiment exposes that limitation instead of claiming production isolation.

UTF-8 byte ceilings conservatively bound individual item payloads (4000), the
complete request (40000), and state plus its longest question (32000). The common
rubric is counted in request/state bounds. These are not measured token counts
or a provider-tokenizer admission proof. Exact tokenization and supported budgets
remain necessary for a live comparison. Oversized input stays unjudged and sends
no request. Full output/state is never silently truncated. Served-model mismatch
stops further acceptance and preserves all physical receipts.

The Jev observer retains literal request JSON and fetched response-body bytes, including
partial/binary error bodies, headers, status, failures and raw input/output
usage. These are fetch-level body bytes, not complete HTTP-wire or compression evidence. Current TypeSafe model documentation verifies jev-1.13.0, input $0.042/M,
free output, 64k whole-request and 32k state-plus-longest-question context bounds:
https://docs.typesafe.ai/models (verified2026-10-08). Native nonzero output usage
remains recorded. List estimates are diagnostic; invoices, cache/tier/geography
adjustments and missing receipts remain unknown. #1226 owns shared metadata
instrumentation; #1239 records the upstream Sonnet5.5 cache-read rate ambiguity.

Whole-workflow accounting requires every supplied generation/fallback/summary
physical receipt, exact terminal raw usage, meaningful request counts and explicit
summary demand. Missing summary demand is unknown, not zero. Known failed
terminal calls retain their cost. Native all-model totals are independent of
provisional assistant frames. Whole-workflow completeness also requires literal
per-physical request/response bytes, natural response completion and reconciled
terminal usage sums; a positive claimed request count cannot replace that proof.
Known terminal diagnostic estimates remain retained when physical coverage is
unknown, including failed calls. Provider SSE needs terminal output and natural
message completion. Latency helpers retain complete observations for p50/p95 and
throughput; these helpers provide no live efficiency result. A protected future
collector/dispatcher still needs actual auth/billing/cap/process admission and
full physical call accounting before a scored run.

The native fixture runs the real installed SDK 0.3.293 / CLI 2.1.293 with the exact
borrowed rubric, eight new cases and an authored loopback Messages response.
An owned launcher supplies an empty home and explicit no-tools/default fixture
policy in separate user/network/PID namespaces. Source/dependencies/runtime are
read-only. All loopback HTTP paths are recorded; the fixture rejects unexpected
paths/models. Raw stdout, stderr, terminal usage, parsed rows and actual process
closure are retained even after decoder/reader failures. This is SDK fixture
policy evidence, not the donor raw-API route or current-core implicit-auto
performance. #1275 remains relevant if a future comparison uses the core route.

Example keyless entries (from repository root with verified Bun1.4.2):

```sh
bun run test packages/ui-server/tests/triage-jev-experiment.test.ts \
  packages/ui-server/tests/triage-jev-evidence.test.ts tests/triage-review-evidence.test.ts
python3 packages/ui-server/evals/triage/experiment/offline-launch.py \
  --bun /absolute/verified/bun --output /fresh/protected/output
bun packages/ui-server/evals/triage/experiment/prepare.ts /fresh/protected/sidecar /current/verification.json
```

Preparation hashes every owned source/runtime/dependency byte and file/directory
mode. Symlinks must resolve within the owned tree and bind target identity and
content. Physical inodes shared outside that tree are rejected; internal links
remain fully represented. Seventeen workspace manifests and the verified Bun
binary are bound. The semantic sidecar includes complete relevant sources,
rubric, all inputs and canonical context. A source hash cannot stand in for
inspected semantics or context capacity. Complementary admission independently
reparses original prompt/auth/settings/model/usage/error/EOF/process/physical
artifacts; flag-only APPROVED and offline-scripted evidence are ineligible.
That complementary receipt does not replace the three-family label panel.

No live comparison, calibration, label approval or adoption decision exists in
these controls. Standing Sonnet5.5/Jev1.13.0 and actual additional-charge caps
remain granted. The coordinator holds Claude requests pending verified included
availability and settles exact additional label-panel models/routes before any
new review calls. A measured decision still needs the authorized matched current
baseline, deterministic baseline and hybrid arms; all retries/fallback/summary
costs; latency/throughput/cache sensitivity; and an explicit go/no-go to #680.
