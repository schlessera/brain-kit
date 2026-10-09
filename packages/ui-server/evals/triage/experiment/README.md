# Bounded T1 triage experiment methods

This is private evaluation preparation for #848 and its decision to #680. The
existing scorer, rubric, donor dataset and benchmark matrix remain unchanged.
The evaluation adds no production triage caller, dependency or public export.
Its separately ruled #1275 core prerequisite explicitly selects default
permissions while retaining the existing tool allowlist and credential gates.

The 40 prospective inputs are newly authored Odysseus counterfactuals: twenty
reference controls, ten tuning cases and ten held-out cases. Their labels are
provisional. The historical twenty donor fixtures still exercise existing
keyless regression tests; their older scenarios and measured rows are not
renamed into this corpus. Shared rubric, world and abstract task concepts limit
split independence even with disjoint IDs, families and templates. Full semantic
review must address that limitation. The unchanged donor README requires three
strong models from different families and unanimous labels. Its old judge roster
is neither current authorization nor proof of three distinct families.

The selected private label panel uses `claude-sonnet-5-5`, `gpt-6.1-sol` and
`gemini-3.8-flash`, as ruled in #848 comment6064579891. It invokes the unchanged
donor `callModel` raw Messages, Chat Completions and generateContent routes, with
the unchanged rubric, high effort, output bound8000, batches of four and three
repetitions. All forty inputs require360 item judgments in90 logical batches.
Only id/source/title/body enter requests; no gold, explanation, split, threshold
or expected output is forwarded. IDs remain visible and contain split prefixes:
this is gold-blind, not identity-blind. Complete valid rows must precede tallying
with the donor parser/judge functions. Endorsement requires complete coverage
and three unanimous modal routes matching provisional gold. Per-repetition vote
counts and instability remain visible; this is not unanimity of all individual
repetitions. Tied modals retain the donor's literal result but block overall
endorsement instead of letting its first-vote tie break decide a label.
Disagreements are reported without automatically changing labels
or excluding cases.

The private lowest-fetch observer owns a serialized scope and always restores
fetch. Keyless controls execute those actual donor calls in a child supplied
only synthetic keys; they do not inspect parent credentials. Gemini's legacy
query key is moved into the documented x-goog-api-key header before dispatch;
the JSON body remains literal. Authentication headers/query values never enter
receipts, echoed secrets are withheld, and failure strings contain no provider
exception text. Complete fetched body bytes, hashes, status, selected safe
response headers, exact served model and raw native usage are retained before
label parsing. Missing native counters stay null despite the donor's zero
defaults. Anthropic fresh input and separate cache counters retain their native
meaning. OpenAI completion totals include reasoning; Gemini candidate and thought
tokens remain separate and sum to output. Optional cache fields remain unknown
when absent. A response containing visible Gemini thought parts is rejected
rather than silently treating thought text as a label answer. Natural EOF is
required for acceptance; failed readers retain prefix bytes and observed
cancel outcome. No process-closure proof is inferred from this fetch observer.
Literal Anthropic/OpenAI request model must match the active selected judge
before transport; Gemini's exact endpoint pins its model. Rejected pretransport
attempts retain their safe request/error and transportDispatched=false, separate
from actual calls handed to the supplied transport.

A known429/503 response may retry once only when model and native input/output
usage are complete. Each attempt is retained separately before tallying. Unknown
usage/model/EOF, auth failure, malformed labels or nonterminal success stops
future batches rather than retrying quality or substituting models/effort.
Panel raw usage remains separate from scored baseline/fallback/summary
accounting. The donor collector keeps its historical price/invoice fields null. The separate
paid controller retains conservative reservation and known-usage upper fields;
they are neither list estimates nor invoices. No successful request, price, availability, effort-probe result or semantic
approval is claimed by these offline controls. The private `panel-run.ts` entry requires a source-bound root allocation and
complete independently reparsed semantic-review artifacts before any request.
Having an entry is not a live access or measurement result.

Selected API/method sources, verified2026-10-08:
https://developers.openai.com/api/docs/models/gpt-6.1-sol,
https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create,
https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash,
https://ai.google.dev/api/generate-content.

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
rubric is counted in request/state bounds. These are not measured token counts. Native review and the raw panel reserve
against verified canonical model context maxima and literal output ceilings;
actual usage must fit those bounds. No extra tokenizer API is required for this
finite conservative price reservation. The scored Jev comparison retains its
whole-request/state engineering limits. Oversized input stays unjudged and sends
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
policy evidence, not the donor raw-API route or an actual core baseline
performance. #1275 remains relevant if a future comparison uses the core route.

Example keyless entries (from repository root with verified Bun1.4.2):

```sh
bun run test packages/ui-server/tests/triage-jev-experiment.test.ts \
  packages/ui-server/tests/triage-jev-evidence.test.ts \
  packages/ui-server/tests/triage-label-panel.test.ts tests/triage-review-evidence.test.ts
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
remain granted. Enabled native paid extra usage is explicitly authorized by #838
comment6065882737. Actual dispatch remains root-controlled and source-bound;
selected panel models/routes are settled and complete semantic/label review
remains pending. A measured decision still needs the authorized matched current
baseline, deterministic baseline and hybrid arms; all retries/fallback/summary
costs; latency/throughput/cache sensitivity; and an explicit go/no-go to #680.


The #1296 paid correction adds direct-native `review-run.ts` with an actual
loopback observer/relay. The root policy binds exact freeze, input, protocol,
runtime, local proof and literal prompt hashes, canonical Sonnet5.5, issued-at/expiry and
remaining allocation. Its USD8/M aggregate input/cache and USD20/M output rates
are conservative planning bounds, not list prices. Each physical request reserves
the full documented1M-token context bound plus its positive literal output ceiling
(max128000) before forwarding, including for short wires. Bytes remain a transport
bound; no byte/token or hidden-framing ceiling is inferred. Completed final named input/output/cache usage
settles only a known conservative upper; errors or missing usage retain their
reservation and stop future requests. Source/runtime closure is independently
checked at both exported entry and actual relay before every physical request.
No tool, high-effort, altered prompt or model substitution passes. Known Standard
absent/global/us geography is covered by8/20; omitted geography remains unknown,
not a measured global route. Observed native `not_available` stays unavailable
measurement; it is not converted to global. Unknown modifiers and observed Priority/fast refuse. The observer disables memory, isolates home/config, checks real account
and settings before releasing the prompt, and retains stdin/stdout/stderr plus
owned child termination/drain evidence.

Pinned native293 `NEe` reports `status:rejected,overageStatus:allowed,
isUsingOverage:true` when the included limit is rejected but paid overage is
permitted. With explicit valid root policy, full HTTP200 canonical usage and
natural EOF/drain, that literal state is accepted unchanged. Actual HTTP402/429,
paid overage rejection/disabled, unknown rates, model/auth failure and incomplete
streams remain failures. Benign inactive `allowed_warning` stays visible.
Account-wide extra-usage meter/FX observations are separate from request usage;
missing invoices remain null. Historic frozen helper diagnostics under #1239 are
not rewritten as current list invoices.

The raw panel uses unchanged donor JSON/effort/output/batching and actual
`callModel`; a new serialized pre-fetch reservation and post-receipt settlement
wrap that call. Redirects are manual: a3xx status/body is retained without
following to an unobserved second endpoint. Every present response pricing
modifier passes before a reservation can be discounted; a failed modifier keeps
the entire unknown reservation. Review descriptors match all fresh sidecar
bindings and the literal full prompt/runtime before grant claim or panel traffic.
Canonical context maxima are1M Sonnet,1,050,000 GPT and1,048,576
Gemini; output remains8000. Raw-panel planning rates are deliberately upper
bounds: Sonnet8/20, GPT11/33 (covering long-context cache writes, Fast and regional
premiums; Responses-only Ultrafast is outside this literal Chat Completions
route), Gemini1.35/6.75 (current priority upper through2026-12-31). Known unsupported
tier/geography/fast changes stop; missing optional cache counts are not called
zero. Anthropic requires both aggregate cache counters; OpenAI total prompt and
completion already include cached/reasoning tokens; Gemini output sums explicit
candidate and thought counters. The controller independently reparses literal
response bytes and binds30 unique donor batch bodies. Each allowed429/503 retry
has its own reservation/receipt; unknown usage prevents retries. Prior review
spending and the root remaining issue/aggregate allocation constrain every next
call; no up-front assumption that all180 attempts will occur or fit is made.

Primary bounds/pricing sources verified2026-10-08:
https://platform.claude.com/docs/en/models/sonnet-5-5/overview,
https://platform.claude.com/docs/en/build-with-claude/prompt-caching,
https://developers.openai.com/api/docs/models/gpt-6.1-sol,
https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash,
https://ai.google.dev/gemini-api/docs/pricing.

Root-only entries take frozen sidecars and private literal policy SHA references:

```sh
bun packages/ui-server/evals/triage/experiment/review-run.ts \
  /frozen/sidecar /protected/root-review-policy.json POLICY_SHA /fresh/review-output
bun packages/ui-server/evals/triage/experiment/panel-run.ts \
  /frozen/sidecar /protected/root-panel-policy.json POLICY_SHA /protected/reviews.json /fresh/panel-output
```

Each root policy also supplies a64-hex one-use grant nonce and absolute private
consumed-marker path. Complete binding checks precede atomic0600 O_EXCL claim;
failed attempts retain the marker and a new output directory cannot reuse it.
Completed receipts reparse the original/copied marker and policy validity as of
claim/physical dispatch, so later expiry alone does not invalidate evidence.
Root alone mints grants against the shared native/API/Jev remaining allocation.

The native entry additionally requires the explicit root dispatch marker and a
supplied existing OAuth environment route; the raw panel requires its separate
root marker and existing API routes. Neither discovers credentials, refreshes a
login, provides a fallback model or declares its own allocation. `verification.json`
is the literal local-proof member included by preparation. All raw approvals,
budget timestamps, request/response hashes and terminal usage are reparsed; a
claimed flag or rewritten artifact hash cannot replace them. Source/runtime
changes, expired policy or missing required proof stops before forwarding.
The networkless `review-offline.ts` controls deliberately remain ineligible even
when the actual native text says APPROVED and paid transport succeeds.

Completed receipts are settled at verified Standard ceilings only after literal
model, named usage, EOF and all observed pricing modifiers pass. Native/Sonnet
fresh input/read/long-write/output rates are2.2/.11/4.4/11 USD per million,
covering documented US1.1x without claiming measured global geography. GPT
requires an explicitly observed Standard/default tier for its tighter5.5/16.5
input/output ceiling: all input is conservatively charged at the longest write
rate, covering missing cache detail and long-context/regional rates. Missing
GPT tier retains11/33. Gemini retains1.35/6.75. These are usage-derived bounds,
not invoices. Full-context pre-reservations and unknown physical holds are
unchanged; no finite hidden-framing bound or token count is inferred from the
tiny donor body. Contradictory present native total counters are independently
refused by the observer and settlement entry.

Settlement sources verified2026-10-08:
https://platform.claude.com/docs/en/about-claude/pricing,
https://developers.openai.com/api/docs/models/gpt-6.1-sol,
https://developers.openai.com/api/docs/guides/fast-mode.
