# Paid CLI provider transport and accounting

This is the finite offline qualification behind
[#2277](https://github.com/schlessera/brain-kit/issues/2277) and a proposed next
integration contract for [#1673](https://github.com/schlessera/brain-kit/issues/1673).
The proposal is unimplemented. It adds no supported option, provider interface,
credential recipient permission or default activation. #1673 still depends on
#1666 and the complete ordinary inference boundary in #1665. The delivered relay
and SDK consumer slices do not satisfy that chain by themselves.

## Measured boundary

`packages/core/tests/paid-provider-qualification.test.ts` launches the installed
native provider factories and real CLI subprocesses in a fresh Linux network
namespace with only loopback enabled. Capabilities are dropped after bringing
loopback up; the child receives a replaced environment and private home. All
keys, data, responses and usage numbers are fictional Odysseus fixtures. The
fixture restores complete replaced fetch/warn descriptors and removes its
private storage. It observes child exits. This is neither a native storage
qualification nor a live billing measurement.

The audit uses the locked `@google/genai` 2.24.0 and the repository's first-party
Gemini, Anthropic and image implementations. The fixed Anthropic destination is
intercepted at the lowest fetch boundary inside the isolated fixture; its
original destination is retained separately. It is not a production endpoint
option or an inference gateway.

| Runtime control | Observation |
| --- | --- |
| Gemini embeddings: 101 texts, query, image, PDF | Two text batches of 100/1 and three additional POST requests; actual model, query prefix and inline MIME types checked |
| Developer API embedding response with usage | Raw HTTP contains prompt-token and modality counts; the installed SDK result drops `usageMetadata` |
| Embedding response without usage | Raw usage remains unknown (`null` in the fixture observation); no token estimate from vector dimensions |
| Gemini image completion and Anthropic PDF completion | Native JSON requests and credential headers; both core providers return text rather than raw usage |
| Anthropic transient 503 then success | Two real requests through the built-in retry path; not one logical completion charged as one physical request |
| Incomplete Anthropic JSON | Native completion rejects; no fabricated successful usage |
| Gemini video success and cancellation | Upload session, binary upload, GET poll, generation POST and DELETE; cancellation still performs owned-file cleanup |
| Actual `index --embeddings`, two hybrid searches | Real CLI index and query requests; existing result/warning envelopes preserved |
| Actual search with absent key | Keyword fallback, warnings and zero embedding requests |
| Actual `process` | Native Gemini completion and existing action/operations/reasoning shape |
| OpenAI image generation/edit; Gemini image | Actual JSON, multipart references/mask, and Interactions routes; credentials observed at fixture upstream |
| Image usage and missing usage | Internal raw usage retained; current table yields an explicitly estimated cost; absent OpenAI usage yields unknown cost |
| Actual image CLI | Output exists; full existing JSON envelope retained, including outputs, note and rename facts; no raw usage field added |

The [Google embedding REST reference](https://ai.google.dev/api/embeddings)
documents `usageMetadata` on both synchronous embedding response shapes,
including prompt-token counts and modality details. This does not guarantee that
every response supplies it. The installed SDK exposes enterprise-only metadata
but discards this Developer API field; the positive raw-response and absent-field
controls distinguish those facts. A future relay can observe these units before
SDK conversion without adding a public embedding-provider seam.

The image CLI preserves `bytes`, `costIsEstimate`, `costUsd`, `model`, `note`,
`output`, `outputs`, `provider`, `reason` and `renamed`
(`const payload`, `packages/module-images/src/cli.ts:397-409`). Its help example
is abbreviated; it is not the complete machine contract. Internal image raw
usage does not imply that this envelope exposes it.

Transport/header and accounting mutations remove the Anthropic credential and
OpenAI image usage forwarding respectively. They fail the named
`NATIVE_ANTHROPIC_CREDENTIAL_PLACEMENT` and `NATIVE_IMAGE_USAGE_PRESERVED`
assertions; restored source passes. These qualify observations, not a complete
host metering integration.

## Proposed next integration contract

The proposed consumer is the existing worker's paid `brain` invocation, with
server-owned admission and usage capture at its concrete provider dispatch.
Standalone local CLI behavior and all existing JSON envelopes stay compatible.
There is no new arbitrary URL dispatcher or pluggable accounting interface.
Implementation must establish the following boundary before activating it.

### Resolve authority before dispatch

The host resolves the installed first-party provider, selected model and actual
native endpoint from an immutable trusted snapshot. It binds a private transport
to the host-owned turn; worker request bodies, model labels, cost routes and
claimed turn IDs cannot choose the credential or its recipient. Native endpoint
overrides are routing facts. Any credential release needs the applicable
host-owned exact-recipient permission; other backend origin rulings do not grant
CLI authority by analogy. Redirects cannot transfer credentials.

Native configuration can include project code. Do not load it into the trusted
host to discover an endpoint. A later implementation needs a concrete data-only
selection path or existing authorized maintenance boundary, with unknown/custom
providers refused rather than treated as first-party evidence.

The current inference relay already strips inbound credentials, selects its
fixed origin/routes and invokes host credentials for each dispatch
(`startInferenceRelay`, `packages/ui-sdk/src/server/inference-relay.ts:64-243`).
Its event has outcome/status, not provider usage
(`InferenceRelayEvent`, `packages/ui-sdk/src/server/inference-relay.ts:40-46`).
For these CLI consumers, the host would supply a non-secret transport projection
and keep real keys outside the worker. A fixture key reaching a loopback upstream
is not proof of that credential-free projection.

### Admit each physical operation and retain native lifecycle

Each actual upstream attempt must share the turn's destination admission,
cancellation and application-byte counter. Retries consume separate attempts.
The core Anthropic provider already retries transient responses; retries in SDKs
and outer wrappers must not evade admission or duplicate one response receipt.
No request means zero observed requests; a failed or cancelled request with
missing usage means unknown spend, not zero spend.

Embedding and generation routes can be constrained to known methods and model
paths. Video requires more: the native Files lifecycle follows a provider upload
URL, sends bytes, polls an owned handle and deletes it with a fresh cleanup
deadline (`withVideoFiles`, `packages/core/src/providers/completions/video.ts:16-83`).
The host must validate upload destinations and retain a private registry of
handles created by that turn. It must not accept worker-selected arbitrary
upload URLs or general GET/DELETE access. The existing POST-only relay cannot be
claimed to cover that lifecycle. Multipart edits must preserve native boundaries,
references, masks and cancellation rather than reconstructing a JSON approximation.

### Capture units before converting the response

A host receipt needs the actual authorized recipient, requested model, provider
response model when supplied, operation, host-generated attempt identity,
completion/error/cancellation state and raw reported usage with its units and
provenance. It must omit prompts, media, credentials and response content from
Activity/audit records. A reported response model is an observation, not new
recipient authority. Missing or conflicting model/usage fields remain explicit.

For Gemini embeddings, parse supported bounded raw HTTP usage before the SDK
converter drops it. Gemini/Anthropic completion providers currently discard
usage when returning text. Image providers retain usage internally and compute
estimates, so their local CLI estimate must not also be booked as a second
provider charge. Unknown fields, malformed/incomplete responses and absent
usage stay unknown; never infer tokens from payload bytes or vector length.

The current shared inference/egress counter measures application or opaque
transport bytes. These units stay separate from provider token, character,
image or time units. Activity's current token pricing uses input/output/cache
classes (`priceUsage`, `packages/ui-server/src/activity/store.ts:1058-1091`);
it cannot silently price image modalities or enterprise billable characters as
ordinary tokens. Image model-table costs remain estimates; unknown model/rate
combinations remain unknown. No live invoice or price validation is implied by
fixture arithmetic.

### Persist once and enforce with honest coverage

The future host admission/receipt owner must associate each physical attempt
with its host-held turn and persist it idempotently before deriving Activity and
budget totals. Replayed callbacks or logical retries must not duplicate a
single attempt; distinct upstream attempts must not collapse into one. Choose a
concrete durable owner and transaction point in the later implementation, with
restart/retry controls, rather than relying on a worker-supplied counter.

Current budget coverage explicitly excludes provider/tool spend
(`createTurnBudgets`, `packages/ui-server/src/brain/turn-budgets.ts:43-194`).
Only qualified recorded units may advance that disclosure. Before activation,
prove refusal before the next dispatch once the applicable known budget is
exhausted, alongside native cancellation/cleanup and deduplication. Exact advance
USD guarantees for concurrent/in-flight requests, unknown usage or unavailable
rates need an explicit reservation/unknown-spend policy; this audit does not
choose one or claim abort reverses a provider charge.

## Limits and next integration evidence

JeV reranking is another paid direct request and is outside this audit's runtime
coverage. Custom providers, Vertex/enterprise endpoints, async embedding batches,
all CLI aliases/enrichment call sites, real workers without copied keys, durable
Activity receipts and turn-budget enforcement remain unqualified. The matrix in
[agent-workers.md](agent-workers.md#paid-cli-provider-qualification) identifies
source consumers; it is not a completeness or default-activation claim.

A concrete later integration must demonstrate a real contained CLI invocation
with no provider credential, an authorized host dispatch, missing/foreign
recipient refusal before contact, native request/response compatibility,
per-attempt accounting, retry/restart deduplication, unknown-cost disclosure,
budget exhaustion and cancelled-media cleanup. Parent issues retain those
criteria and their dependency order. The settled Pi custom OAuth ruling requires
host-owned exact-origin permission per credential; it does not by itself settle
CLI projection or pricing policy.
