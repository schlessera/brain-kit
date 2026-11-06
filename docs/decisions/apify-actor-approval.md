# Apify: Actor approval is the trust boundary

The maintainer ruled on 2026-11-04 that Apify should offer approval for a
specific Actor when it is triggered: approve once, approve always, or deny.
Costs are combined across Actors under Apify-wide spending controls and an
overview; a turn's spend includes its Apify costs. The maintainer explicitly
accepts that third-party Actor behavior and final costs cannot be guaranteed.
A further clarification excludes restrictions on Actor inputs or outputs
except scanning for credential extraction. Modules need an easy availability
check so they can fall back or explain why a feature is disabled.

The ruling and its acceptance criteria are recorded in
[#3580](https://github.com/schlessera/brain-kit/issues/3580). This supersedes the
mandatory qualified-build, exact-build standing grant, crawling-proof and
all-cost-guarantee admission requirements in [the original Apify decision](apify-capability.md).
That record retains the evidence and earlier choice. This record changes the
requirements for implementation; it does not claim the shipped code already
implements them.

## Approval belongs to the Actor

A discovered Actor is not authorized until the user approves it. At invocation,
identify the concrete Actor by its immutable Apify identity, showing its owner,
name, purpose, supplied input, available pricing, requested permissions and
known uncertainties. The user chooses:

- **Approve once:** authorize this pending invocation only. Changed input is a
  changed pending invocation, and cannot spend an earlier one-use approval.
- **Approve always:** remember approval for this specific Actor for the same
  principal, brain and Apify account, across sessions. Another Actor, an alias
  resolving to another identity, another principal or another account does not
  inherit it. The user can inspect and revoke remembered approvals.
- **Deny:** do not dispatch the pending invocation. An approval dialog closing,
  cancelling or expiring is not permission to start a run.

Standing approval is Actor-scoped, not input-, schema- or build-scoped.
Requiring a new review of every ordinary input or build would defeat approve
always. This is not permission to enable the provider, change the account,
raise budgets or extract host credentials. Discovery remains distinct from
execution. Consent state stays in trusted host storage, outside worker mounts
and the disposable index. Existing restrictions on unattended and voice
execution are not broadened by this ruling.

## Inputs, outputs and provider trust

Accept the Actor's ordinary inputs and return its ordinary outputs. Do not
require hand-written integration profiles, a catalog of vetted builds,
URL/path allowlists, a particular pricing model, fixed modes such as no-email,
a prescribed result projection, or proof of the Actor's internal requests as
conditions of user-approved execution. This applies to Store Actors generally,
not only the first Actor used in an experiment. The upstream service may still
reject invalid input; do not invent additional product-level content rules.

Scan inputs and outputs for credential extraction. This exception protects host
credentials and detects attempts to obtain or disclose them; it is not a broad
content filter. Ordinary profile data and the mere presence of an input/schema
field whose name mentions authentication are not themselves proof of credential
extraction. The implementation must test the actual extraction cases and benign
cases separately. Tokens remain host-owned authentication, never implicitly
copied into Actor input, results, model history or a worker's environment.

Treat a remote Actor as a user-approved third-party service. Brain-kit cannot
attest to its internal collection methods, redirects, recipients, retention or
absence of hidden effects. Do not claim a robots guarantee or an enforced
remote network boundary. A lack of such proof does not override an Actor
approval. Provider output remains untrusted data; it cannot approve another
Actor, change policy or promote itself to a system instruction. Removing
Actor-specific content restrictions does not authorize arbitrary REST/MCP
forwarding or a remote instruction to extract host credentials.

## Shared spending and honest coverage

All Actors using the same BrainKit-managed Apify account share the Apify budget
and spending overview. An Actor approval never creates a separate untracked
allowance or bypasses that budget. The host checks remaining configured budgets
before new paid dispatch, reserves for in-flight work and tracks the same
liability across concurrent Actors and processes.

Include Apify charges in the initiating turn's spending alongside inference,
and in the relevant session/day totals. Use the same attributed liability once,
not both a new cost receipt and the reservation it replaces. Distinguish known
charges, estimates, pending reservations and costs awaiting attribution.

The overview and budget accounting cover Actor charges and separately billed
platform operations, including API/storage reads and writes, transfer, and
retention/cleanup. A run's currency cap does not guarantee a total bill for all
of those operations. Use supported upstream caps and bounded host operations
where available; combine their estimates/reservations against the shared
allowance and reconcile actual provider reports. Missing guarantees are not a
new qualification gate. Explain the uncertainty and any overrun caused by delayed
or independently billed charges; never promise a mathematically hard total-cost
ceiling that the upstream service cannot enforce. Stop further dispatch when
the shared allowance is exhausted. Free/prepaid credit offsets payment; it does
not make metered usage zero. Activity outside BrainKit is not silently claimed
as attributed to one of its turns.

A terminal run is not necessarily a final bill. Preserve pending liability and
reconcile later reports under bounded polling/cleanup; do not release a run's
allowance from an immediate zero event count. Unknown dispatch outcomes still
have no automatic start retry. Disabling new work does not abandon owned cleanup.

## Modules can check availability

Provide one straightforward module-facing check using the same host-owned
provider/account/policy/budget state as execution. Modules can ask whether Apify
is available and, when useful, whether a named Actor is ready or needs approval.
Do not add a parallel credential resolver or a new general provider/plugin seam.

Distinguish unavailable with a useful reason, available but requiring Actor
approval, and ready. Disabled provider, missing/rejected authentication,
unconfirmed account, policy denial, unavailable service/accounting and exhausted
budget must not all collapse to a false claim that the Actor is approved.
An approval-required state can lead to the normal interactive approval flow;
it is not a permanent missing-dependency verdict.

Checking availability neither starts a paid run nor consumes a one-use approval.
Expose no token or private credential details. Availability is advisory: the
actual invocation rechecks live authority, approval, credential scanning and
budget state. Modules choose an appropriate fallback or disabled notice from
the result. Do not mutate a provider-facing tool roster or earlier model
messages when availability changes.

## Evidence and rejected alternatives

Authorized direct REST experiments on 2026-11-04 demonstrated successful Store
Actor execution and developer-paid platform usage despite an omitted optional
billing flag. A tiered listing price resolved to a concrete event price in the
run response. Initial terminal responses showed zero events before later reads
reported charges. A below-price cap request was rejected with a minimum not
advertised in listing metadata. These are observations, not guarantees for
other Actors. Sanitized findings live in
[#3577](https://github.com/schlessera/brain-kit/issues/3577); personal inputs,
raw outputs and account/run/storage identifiers remain outside the public tree.

The earlier qualified-build-only design prevented the intended approved-Actor
workflow. Per-input or per-build standing approval would also make approve
always ineffective. Those alternatives are superseded. Unrestricted execution
without prior Actor approval and spending visibility is not the selected model.
