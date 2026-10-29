# Apify: explicit activation, discovery consent and bounded remote execution

The maintainer requested this capability on 2026-10-29. The request establishes
that Apify is an opt-in paid provider, authentication is necessary for paid
requests, policy controls limits, and discovering a tool does not authorize it.
Catalog discovery may ask or be permitted by policy; a newly selected Actor
should be reviewed. These requirements bind the implementation of
[#3157](https://github.com/schlessera/brain-kit/issues/3157).

The maintainer selected **bounded paid execution (option A)** on 2026-10-29
in [#3158](https://github.com/schlessera/brain-kit/issues/3158#issuecomment-6506956383). The concrete
contract below implements that choice: catalog discovery can be allowed by
policy, new Actors ask by default, and paid execution requires a vetted build,
known pricing and enforceable bounds. Unknown or unbounded external spend
refuses; existing inference unknown-price behavior is unchanged.
This record does not activate Apify, change a supported schema, qualify a real
account or authorize a paid experiment. Implementation readiness lives in the
issues, not in this document.

## Evidence and its limits

Brain-kit source was checked at `76192ea488c96569a22a8b1ac87006940d0607e2`.
The existing provider catalog only configures Pi's upstream search extension
(`WEB_SEARCH_PROVIDERS`, `packages/ui-sdk/src/server/web-search.ts:52-125`).
It is not an Apify adapter. Existing policy has turn/session/day budgets,
egress, outward rules and recipient restrictions, but no discovery or Actor grant
fields (`GovernancePolicySchema`, `packages/common/src/governance-policy.ts:35-48`).
Name-based permission admission cannot distinguish different Actors supplied to
one execution tool (`decideToolPermission`,
`packages/ui-sdk/src/server/permission-gate.ts:62-92`). Provider accounting is
already attributed and settled on the host (`observeProvider`,
`packages/ui-server/src/brain/turn-budgets.ts:195-209`).

The official [Apify MCP source](https://github.com/apify/apify-mcp-server/tree/2ba58ba29ecf050874cd2186effa375c5cf6ec60)
was inspected at commit `2ba58ba29ecf050874cd2186effa375c5cf6ec60`.
Links below pin that source. REST documentation was read on 2026-10-29; it is
live vendor documentation, not a measurement of billing behavior.

| Surface | What the inspected implementation does | Consequence for BrainKit |
| --- | --- | --- |
| `search-actors` | Searches public Store metadata; keyword pagination has limitations. Optional use-case text is additional data sent upstream. | Discovery is external disclosure even without an Actor run. Omit optional use-case text. |
| `fetch-actor-details` | Resolves the default build and formats/shortens input metadata and README. | Useful to discover candidates, insufficient to validate an approved non-default build. |
| `call-actor` | Validates Actor input, starts a run, and optionally waits. Run options are distinct from Actor input. | Do not forward arbitrary model-selected run options or treat the wait as the run lifetime. |
| Direct Actor tools | Generate schemas and names from Actor definitions. | Do not expose them dynamically in a model session. |
| Run/status/result/abort helpers | Loading running tools automatically adds helpers for status, dataset items, key-value records and abort. | An upstream tool selector is not the BrainKit authority boundary. |
| MCP Actors and Server Actors | Have additional recursive MCP and HTTP request routes. | Exclude them from initial execution; no recursive authority or generic HTTP relay. |

Source anchors: [discovery schema](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/tools/actors/search_actors.ts),
[details/default build](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/utils/actor_details.ts),
[call options](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/tools/actors/call_actor.ts),
[start/wait](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/tools/actors/call_actor.ts),
[helper injection](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/utils/tools_loader.ts),
[recursive tool construction](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/tools/actors/actor_tools_factory.ts).

There is a material billing-documentation discrepancy. The pinned MCP schema
says `maxTotalChargeUsd` applies to pay-per-event Actors and is ignored for
other models; the live [REST start reference](https://docs.apify.com/api/v2/actors-runs-post)
says it caps all pricing models. Both allow selecting a build tag or number.
A maximum billed item count is not a count of pages actually visited or
records produced. A timeout/memory limit is not a monetary guarantee.

The [Store billing guide](https://docs.apify.com/actors/running/actors-in-store)
distinguishes event fees from separately billed platform usage and post-run
storage. Its currency-cap guarantee does not establish that a run cap covers
all subsequent dataset reads, retention, third-party accounts or nested work.
No fixed price or free-credit balance is used as an authorization fact here.

Cancellation has a second important limit: the pinned MCP implementation
[attempts an immediate abort and logs/swallow errors](https://github.com/apify/apify-mcp-server/blob/2ba58ba29ecf050874cd2186effa375c5cf6ec60/src/tools/actors/actor_run_response.ts).
A cancelled MCP response therefore does not prove a stopped run. The
[REST abort reference](https://docs.apify.com/api/v2/actor-run-abort-post)
describes abort states and an optional graceful shutdown period. Neither a
successful local abort request nor a terminal run implies a zero bill.

Source inspection is not live qualification. No account login, Actor run,
pricing experiment or execution of upstream repository code was performed.

## Requirements already established

- No ambient key, free credit, provider fallback, discovered description or
  `readOnlyHint` enables Apify. Enablement, credentials, discovery permission,
  concrete Actor consent and spend admission are independent.
- Credentials stay on the trusted host. Neither first-party worker receives
  Apify tokens, host configuration, credential commands or browser profiles.
- Existing [G2/G3/G5/G6 governance](governed-writable-workers.md),
  [provider-history](provider-history.md), [module-tool](module-mcp-tools.md)
  and [scraping-politeness](scraping-politeness.md) rules remain binding.
- A remote Actor is an executable service, not a local `SKILL.md`. No local
  skill/plugin installation is needed to call an Actor; no remote instruction
  can install one or modify policy.
- Restricted autonomous authority and voice grant restrictions do not expand.
  Enabling a provider does not enable an unattended workflow.

## Selected architecture

Use a **bounded combination**: host-owned remote MCP for catalog discovery and
formatted inspection, direct REST for authoritative build/schema/pricing
inspection and batch run lifecycle. Configure remote MCP with exactly
`search-actors,fetch-actor-details`; do not connect its execution tools to the
agent. The hosted MCP changes independently, so validate its returned envelopes
and refuse incompatible changes; its latest implementation is not qualified by
this source pin. A changed description never mutates the model's tool roster.

Direct REST lets the host validate the exact build it will request, disable
automatic start retries, persist the run identity, control result reads and
verify abort outcomes. It also avoids relying on the upstream cancellation
response or default-build formatter as authority. Do not use Standby/Server
Actor requests initially: their charging and lifecycle differ from batch runs.

Core owns concrete internal `apify` operations, transport codecs and validated
input/result shapes. `brain apify ... --json` and the core MCP wrappers call
these same operations; there is no new content module, public provider registry,
MCP plugin framework, daemon or package. UI-server owns trusted credential
resolution, live principal checks, approval exchange and durable admission.
Both backends use the existing authenticated worker bridge. Do not add Apify to
Pi's search catalog as though its upstream extension already supported it.

Shared operations require an explicit trusted admission context; there is no
unmetered default implementation. Standalone CLI/MCP runs need the same durable
private operational state and explicit operator policy. Within governed workers
they forward to the host. When no approval interface or explicit standing grant
exists, return `approval_required` without prompting on stdin or starting work.
The implementation must prove concurrent standalone and hosted access share the
same ledger identity; unavailable shared accounting refuses paid admission.

Initially support an operator-provided API token resolved from the trusted
host-only `APIFY_TOKEN` secret. Store an account identity obtained over the fixed API origin;
never infer identity from a token prefix. Do not put token bytes in JSON config,
Markdown, tool arguments, query URLs, environment snapshots or results. OAuth
acquisition/refresh is a later independently scoped option, not an automatic
browser login in this integration. Disablement/revocation still permits narrowly
owned cleanup/status reconciliation using a retained host credential, while
preventing all new paid runs. Deleting credentials may leave an explicitly
unresolved remote run; do not promise successful cleanup after account access
has been revoked.

## Selected policy and consent contract

Add a strict optional `apify` governance block; it is absent/disabled by default.
Names below are selected future configuration, not existing parser input.
Unknown fields refuse validation. Policy is data-only and remains unwritable by
agent runtimes. No default numeric spending entitlement is created.

```ts
apify?: {
  enabled: boolean;                         // default false
  discovery: "deny" | "ask" | "allow";      // default ask after enablement
  actors: "deny" | "ask" | "allow";         // default ask
  limits: {
    run_usd: number; turn_usd: number; session_usd: number; day_usd: number;
    max_runs_per_turn: number; max_requests_per_turn: number;
    max_concurrent_runs: number; max_runtime_seconds: number;
    max_result_items: number; max_result_bytes: number;
    max_retention_seconds: number;
  };
  actor_grants?: Array<{
    account_id: string; actor_id: string; build_number: string;
    profile_id: string; schema_sha256: string; pricing_sha256: string;
    origins: string[]; expires_at: string; max_run_usd: number;
  }>;
}
```

Money is finite, positive for dispatch, and internally represented as integer
microdollars with conservative rounding. Zero limits deny that operation;
negative, nonfinite, overflowing or missing required limits are invalid when
paid execution is enabled. Counters and byte limits are bounded integers;
timeouts must be finite and positive. Global budget limits still apply: an
Apify limit cannot enlarge them. All currency scopes use the existing UTC-day
boundary. Private ledger/grant state is operational evidence outside `brain.db`;
Markdown remains authoritative for user-authored policy. Protect it from workers.

Discovery `allow` means permitted bounded catalog queries, not permission to
send arbitrary brain content. Apply recipient restrictions to the query and
omit optional use-case/telemetry payloads under our control. The accountless
catalog mode described in [Apify MCP docs](https://docs.apify.com/mcp) can be
supported without credentials only after explicit provider enablement and the
same discovery policy; paid execution always requires authentication.
`inspect` follows discovery policy because it sends the selected identifier.
Do not infer private-account storage permissions from public catalog access.

Actor mode `allow` skips the review only for an exact matching unexpired grant.
It never means every Actor. `ask` requests exact-operation consent each time;
`deny` always refuses. A user-approved operation does not persist a standing
rule unless a separate explicit policy edit through existing policy approval
creates it. A one-use consent is held in trusted private state and consumed
atomically with reservation/dispatch. Discovery consent cannot mint it.

A proposal binds brain identity, account, principal, session, turn, policy hash,
Actor owner/id, immutable build id plus requested build number, exact canonical
input hash, complete input-schema hash, effective pricing fingerprint, qualified
profile revision, intended origins and effective limits. Resolve tags to a build
number before review; submit that number and verify the returned build id.
Price fingerprints include effective event definitions, platform-usage billing
party, account tier and coverage facts, not just the advertised minimum price.
Unknown identity, build, price coverage or permission level prevents execution.

Show the actual Actor, recipient/data scope, input summary, units and known or
uncertain charges before consent. Re-read live policy/account/grant state and
refresh relevant metadata before dispatch. Changed input, account, build,
schema, profile, price or authority invalidates the proposal. Redirect aliases
and similar Actor names do not match. Provider enablement and tool-level grants
are additional checks, never substitutes for this concrete admission.

## Selected stable machine operations

All inputs are strict objects. Identifiers returned by the host are opaque,
unforgeable references bound to brain/account/principal/session; users and
workers cannot substitute raw remote dataset/run IDs. CLI words map directly to
these operations with `--json`; core MCP names are shown below.

| CLI / MCP | Selected input | Result data |
| --- | --- | --- |
| `discover` / `brain_apify_discover` | `{query: string, limit?: integer}` | Bounded candidate summaries and opaque candidate references; no execution grant. |
| `inspect` / `brain_apify_inspect` | `{candidate: string}` | Exact Actor metadata/schema plus eligibility and limitations, marked untrusted. |
| `prepare` / `brain_apify_prepare` | `{candidate: string, input: object, max_charge_usd: number}` | Opaque proposal reference or a typed refusal. |
| `run` / `brain_apify_run` | `{proposal: string}` | Owned run handle, lifecycle state and partial-result availability. Approval occurs here if needed. |
| `status` / `brain_apify_status` | `{run: string}` | Lifecycle state and availability, without reading arbitrary account work. |
| `results` / `brain_apify_results` | `{run: string, cursor?: string, limit?: integer}` | Bounded records, opaque next cursor, truncation/partial warnings. |
| `abort` / `brain_apify_abort` | `{run: string}` | Abort requested/confirmed/unresolved; never an assertion of zero spend. |

The machine envelope uses the repository's current CLI/MCP JSON conventions,
with stable error codes: `provider_disabled`, `authentication_required`,
`policy_denied`, `approval_required`, `proposal_stale`, `actor_unsupported`,
`budget_exceeded`, `accounting_unavailable`, `result_expired`,
`remote_outcome_unknown`, `upstream_incompatible`. Do not expose raw secret-bearing
upstream errors. Numeric defaults and maximum envelope sizes are pinned by the
implementation's schemas and tests, within host policy; callers cannot enlarge
policy caps by supplying larger limits.

Detailed accounting, grants and provenance remain internal sidechannel data for
the UI; do not add them routinely to provider messages. The model sees only
facts needed for its next action, such as a refusal, incomplete results or a
new approval requirement. Names, definitions and order stay fixed for a session.
Disabled or revoked capabilities refuse at execution time. No upstream direct
Actor tools, tools/list changes, arbitrary URLs, bearer tokens, webhook targets,
connector IDs or arbitrary REST/MCP method forwarding are accepted.

## Selected execution eligibility and monetary enforcement

Use an initial **qualified batch Actor profile** for each executable
build. Public discovery remains broad, but a discovered Actor without a profile
can be inspected and proposed for review, not run. A profile is concrete trusted
integration code/data for this provider, not an extension seam. It validates the
full exact-build schema, maps each target and page/item/work limit, rejects
secret/connector fields and fixes the supported output/retention contract.

Initially qualify only all-in pay-per-event builds with known account pricing,
limited permissions and a verified platform currency cap. Exclude pay-per-usage,
legacy rentals/pay-per-result, event-plus-usage, unknown billing, full-permission,
recursive MCP, Server/Standby, nested paid runs and outward mutation Actors until
their own measured authority/cost case is accepted. The MCP/REST cap discrepancy
is a qualification requirement, not justification to broaden the subset.
A free Actor can consume paid compute; free credit does not relax admission.

Reserve atomically, durably and across processes before sending a start request.
The reservation covers the run cap plus independently bounded lifecycle/result
reads and retention charges. If current tariffs cannot bound those additional
charges, refuse or offer already-retained results; do not advertise an all-cost
hard cap. Existing turn/session/day enforcement uses the same attributed costs
once, with separate Apify units rather than synthetic tokens. Unknown model
prices keep their existing inference behavior. The selected additional rule is
that **an external operation without a defensible monetary upper bound does not
start**; the maintainer selected this in the ruling below.

Compute effective limits as the intersection of global, provider, Actor grant,
proposal and remaining aggregate limits. Count pending reservations as spend
against every applicable scope. Keep an account-wide provider ceiling across
brains/principals using the same account; it bounds BrainKit-admitted spend,
not activity performed independently in Apify Console or another application.
Runs straddling UTC midnight retain liability against each affected day until
attribution settles; no double dispatch or budget reset releases uncertainty.
The stricter global session/turn bound still applies after a policy change.

Dispatch `POST /v2/acts/{actorId}/runs` with validated input and fixed build,
`maxTotalChargeUsd`, finite timeout and memory; disable automatic retry on this
non-idempotent request. Record a durable dispatch intent first. `waitSecs: 0`
in MCP is not proof the operation is finished. Track the returned run identity
and validate actual account/build/options before making results available.
Timeouts or crashes before obtaining the run ID leave `remote_outcome_unknown`;
do not retry the start or release its reservation based on an empty recent-runs
listing. Without an upstream idempotency guarantee, reconciliation can require
operator evidence and that uncertainty must remain visible.

Status polling and result reads are separately request/byte/time capped. No
webhooks, resurrection, reboot, run update, schedule, task administration,
account-wide run listing or raw key-value/log read reaches the model initially.
Persist only the owned IDs needed by the service. Later reads retain receipt
attribution and their own reservation; expiring local bytes does not prove
remote deletion. Retention and cleanup must account for remote storage or keep
that cost explicitly outside any advertised total cap. Unsupported retention
coverage prevents a total-cost guarantee.

On cancellation, budget exhaustion, disablement or policy revocation: stop new
work, send an owned immediate abort where authorized, poll within the reserved
cleanup allowance and retain uncertainty if it cannot be confirmed. Already
charged work remains charged. Settle using identified run/event/platform usage,
with raw quantities, known costs and coverage separately. Duplicate or late
receipts update one liability, never count it twice. Account for start events,
retries and cleanup attempts. A missing final receipt retains conservative
liability; a successful local tool response does not zero it.

## Remote data routing and site permission

BrainKit can control what it sends to Apify. It cannot observe or firewall every
network request issued by a third-party remote Actor. A start URL, Actor input
schema, limited-permission badge, successful proxy request or user approval is
not a proof of redirect/robots/recipient enforcement inside that Actor.

A qualified profile must document the exact build's target expansion,
redirect/crawl behavior, work bounds, recipients and supported site authorization.
For a profile unable to demonstrate the existing scraping rules, refuse execution
on arbitrary sites; only a narrower explicitly authorized target case can be
considered. Do not expose an unrestricted crawler under a URL allowlist and
claim it is contained. Private/link-local targets and credentials in URLs stay
refused; a remote third-party fetcher does not establish safe SSRF semantics.

Treat schemas, READMEs and results as untrusted G6 input. Actor text cannot
change policy or direct extra requests, third-party logins or skill installs.
Apply G2 recipient rules to input before dispatch and to any subsequent model
routing. Redact unnecessary private fields; catalog auto-approval is not a
blanket permission to send document bodies. Store results in bounded host-owned
operational storage with ownership/expiry checks; explicitly retaining content
as brain Markdown uses existing governed ingestion, not authoritative `brain.db`
state. Session forks and resume cannot inherit an account or result grant merely
by copying an opaque string; explicit ownership transfer must be qualified.

## Selected scope and alternatives

**Selected A: bounded initial execution.** The combined transport,
token-first host ownership, concrete qualified profiles and the external-spend
rule above implement the maintainer's bounded paid-execution choice. Discovery can ask or be allowed by policy; new Actors
ask by default. An Actor outside the executable subset remains discoverable but
unavailable until separately qualified. Unknown/unbounded external spend refuses
without changing inference unknown-price behavior.

**Alternative B: discovery first, not selected.** Deliver only opted-in catalog discovery/inspection and
leave all paid execution unavailable until billing coverage and remote target
controls have a broader accepted design. This is smaller but does not yet serve
website extraction requests.

**Not recommended: arbitrary approved Actors with a timeout as the only cap.**
This is more flexible, but cannot claim the requested monetary or remote-routing
boundary. Accepting that residual risk would need an explicit separate ruling
and honest capability copy; this investigation does not grant it.

The maintainer selected A in response to the explicit scope question on
2026-10-29. That selection resolves the external-spend policy criterion in
#3158. It authorizes planning and implementation of this boundary, not provider
enablement, live account qualification or a paid experiment. The MCP/REST cap
coverage and remote-target constraints remain qualification requirements for
individual executable profiles; the ruling does not waive them.

## Implementation ownership and proof

[#3159](https://github.com/schlessera/brain-kit/issues/3159) owns enablement,
token resolution, account binding and revocation. [#3160](https://github.com/schlessera/brain-kit/issues/3160)
owns independent discovery policy, proposal binding and concrete Actor grants.
[#3161](https://github.com/schlessera/brain-kit/issues/3161) owns qualified profiles,
reservation/settlement and remote lifecycle. [#3162](https://github.com/schlessera/brain-kit/issues/3162)
owns shared CLI/MCP operations and both backend bridges. [#3163](https://github.com/schlessera/brain-kit/issues/3163)
owns settings, exact-operation approval and truthful accounting presentation.
These references describe ownership, not a progress checklist.

Use synthetic Odysseus inputs and a loopback MCP/REST fixture. Exercise real
worker-to-host paths with allowed and denied controls for both backends:
discovery ask/allow/deny; token present but provider disabled; arbitrary Actor
substitution; different account/build/schema/pricing/input after consent;
malicious metadata; credential sentinels; same remaining currency raced by two
processes; start-response loss; duplicate receipts; failed remote abort;
restart/day rollover; cross-session result handles; missing grant interface;
result/retention exhaustion and denied redirect/private targets. Break each
admission/accounting guard and record the expected failed assertion before
restoring it. Existing provider-history guards must remain unchanged.

This investigation adds no runtime and therefore supplies source evidence, not
passing Actor-execution tests. Implementation updates supported configuration,
CLI/MCP schemas, error envelopes, wire/receipts and their integration-contract
components in the same `CONTRACT:` commit, with changesets. This design record
does not change today's integration contract or package contents.
