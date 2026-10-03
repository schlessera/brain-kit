# Pi configured endpoints and native authentication

**Decided by the maintainer, 2026-10-03.** The [configured-endpoint
ruling](https://github.com/schlessera/brain-kit/issues/762#issuecomment-5970435185)
and [authentication-precedence
ruling](https://github.com/schlessera/brain-kit/issues/762#issuecomment-5973345145)
bind endpoint selection for explicitly declared built-in pi profiles.
[Documentation prerequisite #938](https://github.com/schlessera/brain-kit/issues/938)
records the policy; [#762](https://github.com/schlessera/brain-kit/issues/762)
owns implementation and its routing migration. This record describes the
approved target, not a claim that the adapter fix already ships.

## Routing and ownership

Validate the declared built-in provider/model identity first, then obtain its
configured model from the **same native `ModelRuntime` used for inference**.
Do not pass the unconfigured catalog object as the model for that request.
For every request, including subsequent requests in a resident session:

1. If native authentication supplies an endpoint, that endpoint wins.
2. Otherwise, use the configured model endpoint, including a native
   `models.json` override; without an override this is the native default.

A configured proxy is conditional on native authentication not supplying an
endpoint. It is not an unconditional inference-routing guarantee. A differing
authentication endpoint is supported native behavior, not a configuration
conflict that brain-kit rejects. Never force native credentials to the
configured endpoint. Credential discovery, refresh, account/subscription
routing and billing ownership stay with pi; brain-kit neither copies those
rules nor caches an authentication endpoint at session creation.

Explicit profiles, picker ordering and built-in eligibility stay intact.
Preserve the exact selected provider/model identity and native model metadata.
An unavailable declared model must fail instead of releasing selection to
ambient credentials. Ordinary resumes remain pinned to their saved model and
refuse native fallback. This policy adds no custom-model discovery, brain-kit
endpoint field, schema, provider seam or dependency update.

## Supported native integration inputs

On 2026-10-03, a frozen install at main `ab55924e` resolved the backend's
coding-agent, pi-ai and pi-agent-core dependencies to **0.99.2**. Their installed
manifests and source were inspected again for this record. The
[version-matched model guide](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/models.md#configure-a-compatible-endpoint)
describes compatible endpoint configuration, and the
[SDK guide](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/sdk.md#configuring-a-session)
documents session configuration. Use the installed public SDK surface:

- `ModelRuntime.create()` and `getModel(provider, id)` for native configured
  lookup; `CreateAgentSessionOptions.modelRuntime` for inference using that
  same runtime, and `model` for an explicit new-session selection.
- Native `getAgentDir()` discovery: `PI_CODING_AGENT_DIR` when supplied,
  otherwise pi's normal user agent directory. The installed runtime defaults
  `models.json`, `auth.json` and the model cache to that directory. With an
  explicit SDK `agentDir`, `createAgentSession` derives model/auth paths from
  it. Preserve that relationship when creating the runtime explicitly; do
  not confuse the brain's session-storage directory with its native agent
  directory or add a second configuration reader.
- The SDK restores a saved session's provider/model using the supplied
  runtime's lookup. A resume receives `modelRuntime` without a new `model`
  override and retains the adapter's fallback refusal and disposal.
- Native public inference operations resolve authentication for each
  request. The installed `dist/core/model-runtime.js` uses the authentication
  result's `baseUrl` ahead of the model URL. Its private `prepareRequest`
  method explains the observed behavior; it is **not** a supported adapter API.
  The [version-matched upstream implementation](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/model-runtime.ts)
  is additional source evidence, not permission to call private internals.

The concrete adapter integration points, rechecked at that main revision, are:

| Existing boundary | Required integration |
| --- | --- |
| Declared-model validation (`export function toModel`, `packages/ui-backend-pi/src/profiles.ts:57-77`) | Keep built-in validation and identity refusal, then select the configured model from the inference runtime. The current function returns the raw catalog object. |
| Ordinary/autonomous new sessions (`async newSession`, `packages/ui-backend-pi/src/session-runtime.ts:36-60`) | Supply the native configured runtime and its selected model to the real `createAgentSession` call. Keep ordinary disk storage and autonomous `SessionManager.inMemory`. |
| Ordinary persisted resumes (`async openSession`, `packages/ui-backend-pi/src/session-runtime.ts:62-101`) | Supply the configured runtime without a new model override; reject/dispose if `modelFallbackMessage` is present. |
| Native resources (`const agentDir = getAgentDir()`, `packages/ui-backend-pi/src/session-resources.ts:73-100`) | Use the same native agent-directory discovery as settings/resources. Preserve loader failure behavior and its inline permission gate. |

Runtime construction belongs at these concrete session boundaries. No runtime
factory option, new public seam or authentication wrapper is needed. An
existing resident session keeps its native inference runtime; later requests
still obtain native authentication afresh. This decision does not introduce a
hot-reload promise for edits to `models.json`.

## Evidence and its limits

The [initial comparison](https://github.com/schlessera/brain-kit/issues/762#issuecomment-5970103386)
and [authentication comparison](https://github.com/schlessera/brain-kit/issues/762#issuecomment-5970534804)
record disposable offline controls against installed pi 0.99.2 at main
`1d1fcc72`. They are dated research receipts, not checked-in adapter regression
tests or fresh inference runs performed for this documentation change.

| Control | Observation | What it establishes |
| --- | --- | --- |
| Raw catalog model, native AgentSession, nonempty prompt | One non-fixture attempt refused before transport; zero fixture requests | The raw model can miss native endpoint configuration. |
| Configured runtime/model, new native session | One loopback request and fixture assistant output | A viable configured-model SDK path. |
| Reopen the saved in-memory native session without overriding its model | One additional loopback request; provider/model preserved | Native resume feasibility, not adapter persisted-resume proof. |
| Bogus future-valid Copilot credential with a differing configured endpoint | One attempt at the native credential endpoint | Native per-request authentication precedence. The request was blocked, not successful inference. |
| Replace that credential in the same session, prompt again | One attempt at the new native endpoint; zero configured-endpoint attempts | Credential changes can change destinations after startup. This did not exercise token refresh. |
| Matching endpoints and no explicit configuration override | Native resolution controls passed without network attempts | Benign candidate inputs remain valid; full adapter transport controls are still required. |
| Rejected alternative's disposable public `getAuth` guard | One guard invocation and expected conflict error; zero model requests | Bounded viability of conflict refusal, not the chosen behavior or full provenance/race proof. |

The probes isolated agent/config/cache/credential stores, used bogus keys and
empty tools/resources, disabled catalog refresh and retries, and ran with
loopback-only kernel network isolation plus refusing transport guards.
Destinations were observed unchanged. No paid or remote inference succeeded.
The earlier private request-preparation probe proves only model lookup and
preparation; it must not stand in for a real AgentSession request.

GitHub Copilot's installed `dist/auth/oauth/github-copilot.js` concretely
derives the endpoint from the current credential and retains subscription
metadata. Native refresh may contact its own authentication servers. Neither
this policy nor refusal before model inference promises no network use by
credential refresh.

## Required implementation proof

#762 must exercise the real adapter and installed AgentSession runtime with
isolated fixture stores, nonempty prompts and unchanged request destinations.
Keyless loopback inference and guarded attempts are separate evidence:

| Path/input | Required observation |
| --- | --- |
| Ordinary new turn, configured API-key model | Positive loopback request count and fixture response at the full configured destination; exact declared model identity and ordinary persisted history. |
| Autonomous new turn, configured API-key model | Positive loopback count and response; unchanged exact tool authority and no persisted transcript, catalog entry or resumable identity. |
| Ordinary persisted resume | Real on-disk reopen through the adapter with no new model override; positive configured-destination count and saved identity. Missing saved model/auth still refuses fallback. |
| Native authentication supplies a different endpoint | Actual request attempts use that full endpoint; zero attempts at the conflicting configured URL. Block remote transport rather than claiming remote success. |
| Changed and refreshed credentials | A later request in the same session follows the current native endpoint, including a separate controlled refresh case. A startup-only check or manual credential replacement alone is insufficient. |
| Matching endpoint and no explicit override | Real adapter positive controls remain usable; preserve endpoint path semantics, native metadata and account/subscription ownership. |
| Invalid declared built-in identity or unavailable saved identity | Actionable refusal before any model-bearing request; no ambient provider/model substitution. |

Apply precedence coverage across ordinary/autonomous new turns and ordinary
resumes, and exercise a subsequent request in a resident ordinary session.
Disable real catalog refresh and isolate refresh transport too; a fixture
refresh can succeed locally, while a refused remote refresh is only a blocked
attempt. Record request counts and exact destination assertions, never key
values. Fixtures do not need provider credentials or external network access.

Temporarily restore raw-catalog selection on new sessions and substitute an
unconfigured model lookup/runtime on persisted resumes; show the named destination/count
assertion fail. Separately force the configured endpoint ahead of native auth
and show the native-destination assertion fail, including changed/refreshed
credentials. Remove the saved-model refusal and show its zero-request/refusal
assertion fail. Restore each mutation and rerun the affected tests; an import
error or an earlier unrelated failure is not the claimed receipt. Merely
omitting `modelRuntime` on a resume can still use the SDK's configured default
and is not a useful mutation when it preserves the required behavior.

Preserve [#675](https://github.com/schlessera/brain-kit/issues/675)
nonpersistence and existing runtime/tool tests, the
[loaded-runtime requirements](runtime-requirements.md), and
[backend conformance](backend-conformance.md). Ordinary persistence is the
nonpersistence positive control. Endpoint support neither contains runtime
filesystem/credentials/network access nor enables autonomous dispatch:
[async collaboration's containment gate](async-collaboration.md) remains
binding. The declared capability is not enablement proof.

## Migration and rejected alternatives

Honoring previously ignored configuration changes consumer-visible routing.
The final ruling approves `contract` and `breaking` treatment on #762, a
`CONTRACT:` commit, integration-contract and backend guidance in the same
commit, and a changeset naming the configured-endpoint routing change and
native-authentication precedence. Under
[contract versioning](contract-versioning.md), the approved break ships in a
minor before 1.0 and a major from 1.0. No release date or dependency update is
selected. Keep existing implementation reference docs truthful until the fix
lands; this documentation prerequisite changes no current contract behavior
and needs no package changeset.

Three alternatives were rejected:

- **Exclude configured endpoints.** It would refuse a supported native
  proxy/compatible-endpoint use case whose SDK path is already demonstrated.
- **Reject solely because native auth supplies a different endpoint.** It
  would stop otherwise supported subscription/account routing and add a
  separate per-request conflict policy, contrary to the final ruling.
- **Force native credentials to the configured endpoint.** It would override
  native account routing and credential ownership. Configured proxy support
  does not authorize credential forwarding to a different destination.

Implementation status, remaining verification and readiness belong to #762,
not to a checklist or progress field in this record.
