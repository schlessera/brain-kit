# External compute: interchangeable providers for bounded command jobs

The maintainer requested generic external compute on 2026-10-28 in
[#3103](https://github.com/schlessera/brain-kit/issues/3103): several
configured providers, several instances of one provider, and Boat as the first
shipped provider. Shipping a provider makes it available for explicit
configuration; it never enables paid execution by itself. Compute providers are
distinct from model providers and agent backends. This record is the contract
and terminology design that [#3104](https://github.com/schlessera/brain-kit/issues/3104)
owes before any implementation, and it records the maintainer's rulings of
2026-11-02 on the questions that design left open.

This record adds no runtime and changes no supported schema, CLI word, MCP tool
or package. It authorizes no vendor call, credential, paid allocation or live
qualification. Readiness and progress live in the issues.

## Evidence and its limits

Brain-kit source was read at `a62db8f27a22fd2df744308e9b1ee12bc50f3da2`.

- Every core seam resolves a built-in name against a static registry or uses a
  passed-in value as-is (`resolveEmbeddingProvider`, `packages/core/src/lib/registry.ts:98-107`).
  Agent runners use the same mechanism (`AGENT_RUNNERS`, `packages/core/src/lib/registry.ts:76-81`).
- An `AgentRunner` is a one-shot coding-agent CLI run in a local checkout
  (`export interface AgentRunner`, `packages/core/src/lib/seams.ts:46-61`).
  Agent backends drive a chat session over the wire protocol and are wired by
  the host, not by brain config (`export interface BackendRegistryOptions`,
  `packages/ui-server/src/agent/backend.ts:43-57`).
- Governance already owns budgets, egress, outward actions, taint and
  path-to-recipient restrictions (`export const GovernancePolicySchema`,
  `packages/common/src/governance-policy.ts:101-130`). Turn budgets refuse
  admission once any scope is blocked, but reserve nothing in advance
  (`async providerAdmission`, `packages/ui-server/src/brain/turn-budgets.ts:377-382`).
  The Queue budget is the existing reserve-then-settle ledger
  (`export function createInboxBudget`, `packages/ui-server/src/inbox/budget.ts:149-154`).
- Host operational state lives beside the server database and is masked from
  workers (`export interface OperationalStateLayout`,
  `packages/ui-server/src/brain/operational-state.ts:102-106`). Core has no
  state directory outside the brain checkout today.
- [apify-capability.md](apify-capability.md) is the nearest precedent: a paid
  remote executor with host-held credentials, durable dispatch intent, opaque
  host handles and no blind retry of a non-idempotent start.

Boat's public documentation and OpenAPI description were read on 2026-11-02
without credentials. They are vendor documentation, not measured behaviour.

| Boat fact (live docs) | Consequence for the contract |
| --- | --- |
| The compute resource is a *sandbox*; a Boat *environment* is a named configuration bundle, not a machine. | Contract words must not borrow vendor nouns; "environment" stays vendor configuration. |
| Sandbox states `init`, `provisioning`, `provisioned`, `cloning`, `ready`, `idle`, `running`, `archiving`, `archived`, `error`, `cancelled`; a setup script runs after `ready` with its own `setupStatus`. | Provider readiness and setup completion are separate facts; the generic lifecycle cannot treat "ready" as "staged". |
| Stop archives the disk and loses memory and processes; there is no pause. Stopped disks are kept 14 days. | Stop is release with retained data, never a process-preserving pause; retention is a reported limitation. |
| `ttlSeconds` auto-stops from create or resume (default 3600, `null` disables); it is not an idle timeout. | A provider-side backstop exists, but the host lease stays authoritative and is always finite. |
| `POST /sandboxes` accepts an `Idempotency-Key` (24 h) and `labels`; sandboxes can be listed by label. | Lost create responses are reconcilable without duplicate allocation when the provider says so. |
| Commands are synchronous up to 600 s or detached with a process id, pollable output offsets and a kill. A `502` may mean the command ran. | Long jobs run detached; an ambiguous exec is `uncertain`, not retried. |
| Scoped keys can grant only `sandbox.*`, `exec` and `file.*` actions to keys without account administration. | Job credentials can be run-only; administration authority is never needed. |
| Per-sandbox usage reports seconds and list-price dollars after the fact; rates are published on a pricing page. | Cost estimates come from operator configuration, actuals from the provider; neither is hardcoded. |

Sources: [API overview](https://docs.boat.dev/api/v1), [key scopes](https://docs.boat.dev/api-keys/scopes),
[environment access](https://docs.boat.dev/environments/access),
[readiness](https://docs.boat.dev/readiness), [stop and retention](https://docs.boat.dev/snapshots/stop),
[auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop), [limits](https://docs.boat.dev/limits),
[pricing](https://docs.boat.dev/pricing). #3106 rechecks them at implementation time.

## Rulings

The maintainer ruled on four questions on 2026-11-02, after this design laid
out the options.

1. **Terminology: External compute.** The capability is *external compute*. An
   implementation is a *compute provider*. A configured implementation with its
   own settings and credential is a *provider instance*. An allocated execution
   environment is a *sandbox*. A unit of requested work is a *job*. Public
   names follow: config key `compute`, CLI namespace `brain compute`, MCP tools
   `brain_compute_*`, interface `ComputeProvider`.
2. **A public `@experimental` seam.** `ComputeProvider` becomes the thirteenth
   extension seam, with `defineComputeProvider`, under the existing
   meta-mechanism. #3105 adds it to the seam table in
   [extending/README.md](../extending/README.md), the integration contract's
   "Extension interfaces" table and binding decision 2 in
   [ROADMAP.md](../../ROADMAP.md), together with the interface.
3. **Boat ships as a separate lockstep package**, `@schlessera/brain-compute-boat`,
   resolved by the built-in name `boat`.
4. **A job may start with an unknown cost.** A finite lease is still mandatory.
   An operator-configured hourly ceiling is optional: when it is present,
   admission reserves `ceiling × lease` against budgets; when it is absent, the
   job runs with its cost recorded as unknown and the lease, concurrency cap and
   existing budget blocks as its bounds. This deliberately departs from the
   Apify rule that an external operation without a defensible monetary upper
   bound does not start; that rule stays in force for Apify.

### Alternatives considered

- **Remote execution** (`brain remote`): fits SSH, but "remote" already means
  git remotes and remote MCP servers in this repository.
- **Cloud sandboxes** (`brain sandbox`): excludes the self-hosted second
  implementation, and "sandbox" alone already names the worker and HTML-preview
  sandboxes. It survives only as the noun for one allocation.
- **Internal registry only**: smaller contract surface, but a second provider
  would need a brain-kit PR, which does not meet the multiple-provider request.
- **Boat inside core** (with plain fetch or the vendor SDK): no new package, but
  vendor code ships to every install. The separate package keeps vendor
  transport out of core.
- **Refuse unless bounded**: consistent with Apify. Rejected for compute because
  a finite lease on a per-second-billed machine already bounds exposure in
  practice, and requiring operators to copy a price list into config would go
  stale.

## The new category is not an existing one

| Category | What it does | Where it is selected |
| --- | --- | --- |
| Model providers (embeddings, completions, rerankers) | Answer an inference request. | `brain.config` provider values. |
| `AgentRunner` | Runs a coding-agent CLI once, locally, for a skill flow. | `brain.config` `agentRunner`. |
| `AgentBackend` | Drives a chat session's model loop over the wire protocol. | Host environment, first-party packages. |
| `ComputeProvider` (new) | Allocates a disposable sandbox, runs commands in it, returns results and releases it. It runs no model and holds no conversation. | `brain.config` `compute.providers`, by explicit instance id. |

A compute job may run a coding-agent CLI inside a sandbox as an ordinary
command. That does not make the sandbox an agent backend, and a remote shell is
not evidence of governed-worker equivalence.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `@schlessera/brain` (core) | The `ComputeProvider` seam and its types, the registry entry for `boat`, the shared conformance suite, the host-independent job lifecycle and durable job store, and the `brain compute` CLI and `brain_compute_*` MCP operations. |
| `@schlessera/brain-compute-boat` | Boat transport and mapping only. No lifecycle policy, no admission and no consumer-visible Boat semantics. Loaded lazily only when an instance names `boat`. #3106 settles its dependency declaration under the release skill, with no runtime import cycle. |
| `@schlessera/brain-ui-server` | Hosted admission: authenticated caller identity, approvals, data-routing policy, budget and concurrency reservation, Activity, abort and shutdown, and credential resolution outside worker-readable environments. |
| Provider instances | Operator configuration in `brain.config`. Secrets are referenced by environment variable name and resolved on the trusted host. |

On the project board, #3103 joins the Answer quality track beside the Apify
epic (#3157), the other capability that sends agent work to an external paid
executor. No new track is needed.

## The contract

### Configuration

Unconfigured is the default: no `compute` key means no provider, no network
access and the refusal `compute_disabled` from every operation except `health`.
Instance ids are the keys of `compute.providers`. No instance is a default
target.

```ts
export default defineConfig({
  compute: {
    providers: {
      // Two instances of one built-in, separately configured and authorized.
      "boat-small": {
        provider: "boat",
        apiKeyEnv: "BOAT_CI_KEY",
        options: { machine: "small", from: "odysseus-ci" },
        lease: { maxSeconds: 3600 },
        maxConcurrent: 2,
      },
      "boat-large": {
        provider: "boat",
        apiKeyEnv: "BOAT_HEAVY_KEY",
        options: { machine: "large" },
        lease: { maxSeconds: 7200 },
        maxConcurrent: 1,
        hourlyCeilingUsd: 0.1,
      },
      // A community implementation passed by value.
      "ithaca-host": {
        provider: sshCompute({ host: "ithaca.example", workRoot: "/srv/jobs" }),
        lease: { maxSeconds: 1800 },
        maxConcurrent: 4,
      },
    },
  },
});
```

The generic keys are `provider`, `apiKeyEnv`, `options`, `lease.maxSeconds`,
`maxConcurrent`, `hourlyCeilingUsd` and `retainOnRelease`. `options` is opaque
to core and validated by the implementation's own schema. `lease.maxSeconds` is
required and finite. `apiKeyEnv` names a variable; the key itself never appears
in config, job records, receipts, tool arguments or results. The Boat built-in's
default variable name is chosen in #3106.

### The seam

```ts
/** @experimental Extension seam */
export interface ComputeProvider {
  readonly id: string;                      // implementation id, e.g. "boat"
  readonly capabilities: ComputeCapabilities;
  configSchema?: ZodType;                   // validates `options`
  health(ctx: ComputeContext): Promise<ComputeHealth>;
  allocate(req: AllocateRequest, ctx: ComputeContext): Promise<AllocateOutcome>;
  find?(key: AllocationKey, ctx: ComputeContext): Promise<FindOutcome>;
  stage?(sandbox: SandboxRef, source: SourceBundle, ctx: ComputeContext): Promise<StageOutcome>;
  exec(sandbox: SandboxRef, command: CommandSpec, ctx: ComputeContext): Promise<ExecOutcome>;
  poll(handle: CommandHandle, ctx: ComputeContext): Promise<CommandStatus>;
  kill(handle: CommandHandle, ctx: ComputeContext): Promise<KillOutcome>;
  collect?(sandbox: SandboxRef, request: ArtifactRequest, ctx: ComputeContext): Promise<CollectOutcome>;
  release(sandbox: SandboxRef, mode: "discard" | "retain", ctx: ComputeContext): Promise<ReleaseOutcome>;
  usage?(sandbox: SandboxRef, ctx: ComputeContext): Promise<CostObservation>;
}

export interface ComputeCapabilities {
  commands: true;                           // the only workload kind in this slice
  detached: boolean;                        // commands outlive one request
  idempotentAllocate: boolean;              // allocate honours AllocationKey
  findByKey: boolean;                       // find() can locate a lost allocation
  stage: { maxBytes: number } | false;
  collect: { maxBytes: number } | false;
  retain: { maxSeconds: number } | false;   // release("retain") keeps data
  maxLeaseSeconds: number;                  // provider-side ceiling
  remoteExpiry: boolean;                    // provider enforces its own auto-stop
  usage: "actual" | "none";
}
```

`ComputeContext` carries the resolved secret, an abort signal, a deadline, a
`fetch`/transport the host may replace in tests, and a logger that redacts the
secret. Every method returns a typed outcome rather than throwing for expected
vendor states. A transport failure whose effect is unknown returns
`{ kind: "uncertain", reason }`, never a guessed success or failure.

Core checks capabilities before any effect. Requesting staging, collection,
retention or a lease the instance cannot honour refuses with
`capability_unsupported` and allocates nothing.

### Job lifecycle

A job is a host-owned record. Providers never see or mutate it.

| State | Meaning |
| --- | --- |
| `admitted` | Policy, identity, source and budget checks passed; the reservation is held. |
| `allocating` | An allocation intent with its `AllocationKey` was durably written before the provider call. |
| `staging` | The sandbox is ready and the declared source bundle is being transferred. |
| `running` | The command was started; its handle is recorded. |
| `collecting` | The command exited; declared artifacts are being fetched. |
| `releasing` | Release was requested; the outcome is pending. |
| `uncertain` | An effect happened or may have happened and its outcome is unknown. New effects stop until reconciliation resolves it. |

Terminal states: `succeeded` (exit 0, artifacts collected), `failed` (nonzero
exit, signal, OOM or provider error, with the exit status kept), `cancelled`,
`expired` (lease deadline reached), and `abandoned` (an operator accepted an
unresolved `uncertain` outcome). Every terminal record keeps `released`,
`release_failed` or `retained_until` as a separate cleanup fact, so a failed
cleanup can never read as success.

Refusals are not job states. They return before any effect, with stable codes:
`compute_disabled`, `provider_unknown`, `provider_unavailable`,
`capability_unsupported`, `lease_required`, `policy_denied`,
`approval_required`, `source_refused`, `budget_exceeded`,
`concurrency_exhausted`, `accounting_unavailable` and `job_unknown`.
`provider_unavailable` covers a missing credential, a missing first-party
package and a failed health check.

### Lost effects and recovery

- Before `allocate`, the host writes the intent with an `AllocationKey` derived
  from the job id. With `idempotentAllocate`, a retry sends the same key. With
  only `findByKey`, the host looks before it retries. With neither, a lost
  response leaves the job `uncertain` and allocates nothing more.
- An `uncertain` exec is never re-run. The host polls the recorded handle or,
  without one, leaves the job `uncertain` until the lease expires and release
  is attempted.
- On restart, reconciliation visits every non-terminal job: it resumes polling,
  releases expired leases and re-reads `uncertain` allocations through `find`.
  It never provisions on the strength of an empty listing.
- Lease expiry kills the command, collects nothing further and releases. A
  provider with `remoteExpiry` also receives a remote auto-stop no later than
  the host deadline plus the release allowance, as a backstop for a host that
  dies.
- Cancellation stops new effects, kills the command and releases. Its result
  says whether release was confirmed. Already incurred cost remains.

### Source, artifacts and data export

Nothing is uploaded unless the job declares it. A `SourceBundle` is an explicit
manifest of repository-relative paths or a git tree-ish inside a workspace,
plus a content hash. The host resolves it, checks each path against existing
data-to-provider policy (`providers` rules with the instance id as recipient),
egress and taint, and records the manifest hash on the job. The brain root is
never an implicit source, and an empty manifest is valid. Artifacts are declared
paths with byte caps, stored in host operational storage under the job and
returned with their hashes. They do not become brain content without the
existing governed ingestion.

Sandbox environment variables come from an explicit allowlist of non-secret
values. Owner, model, GitHub and provider credentials are never forwarded. Boat
sandboxes are created without an attached Boat environment unless the instance
names one.

### Identity, admission and leases

Every job records the caller: `cli` (the local operating-system user),
`mcp` (the MCP client's process principal), or `hosted` (the authenticated
session principal, session and turn supplied by the host, never by tool
arguments). Admission is the same function for all three. It checks enablement,
the instance, capabilities, a finite lease within every ceiling, the source
policy, approvals where policy requires them, a concurrency slot per instance,
and budget. When `hourlyCeilingUsd` is set, it reserves `ceiling × lease`
across turn, session and day scopes before allocation. An unavailable ledger
refuses with `accounting_unavailable`. A missing ceiling is not an unavailable
ledger; it admits under ruling 4 with cost unknown.

Admission and the job store must serialize across processes, so that a CLI run
and a hosted run cannot both take the last slot. Skills only call these
operations; none of this logic lives in a `SKILL.md`.

### Cost

```ts
interface JobCost {
  estimate: { usd: number | null; basis: "ceiling" | "none" };
  actual: { usd: number | null; coverage: "complete" | "partial" | "unknown"; source: "provider" | "none" };
}
```

Unknown is `null` with a coverage marker. It is never zero. Actual cost comes
from the provider's usage report after release, when it has one. Retained data
reports its retention deadline; provider retention charges are a reported
limitation, never folded into a claimed total.

### State

Job records, intents, leases, reservations and artifacts live in a compute
state directory outside the brain checkout and outside `brain.db`. Hosted, it is
host operational state, masked from workers like the server database. Standalone,
it defaults to a per-brain directory under the user's state home. Records are
written atomically and are the authority for reconciliation; `brain index
--force` neither reads nor rebuilds them.

### Operations

The CLI and MCP surfaces call one core operation set (#3107). Names here are
selected for implementation; their exact JSON shapes land with the code and
its contract documentation.

| CLI | MCP | Does |
| --- | --- | --- |
| `brain compute health [--provider ID]` | `brain_compute_health` | Lists instances, capabilities and readiness without allocating. |
| `brain compute plan --provider ID ...` | `brain_compute_plan` | Runs admission without effects and returns the would-be lease, source manifest, cost estimate and any refusal. |
| `brain compute run --provider ID ...` | `brain_compute_run` | Admits and starts a job; returns its opaque id and state. |
| `brain compute status JOB` | `brain_compute_status` | State, exit status, cleanup fact and cost. |
| `brain compute cancel JOB` | `brain_compute_cancel` | Cancels and reports whether release was confirmed. |
| `brain compute collect JOB` | `brain_compute_collect` | Returns bounded output and artifact references. |

Job ids are opaque host handles bound to the brain and the caller. A caller
cannot address another caller's job or substitute a raw vendor id. Status and
cost details stay out of provider-facing history unless the agent asked for
them, under [provider-history.md](provider-history.md).

### Local stays the default

Nothing runs remotely unless a caller names a provider instance. No ordinary
shell command, skill step or agent tool is redirected. Agent guidance (#3107)
recommends local execution for cheap work and a provider only for isolation or
overflow, with the data export and cleanup consequences stated.

## The second implementation, tested against the surface

An SSH or self-hosted provider is the plausible second production
implementation. Mapping it through the same interface needs no consumer change:

| Operation | Boat | SSH host |
| --- | --- | --- |
| `allocate` | `POST /sandboxes` with `Idempotency-Key`, labels and `ttlSeconds` | Create a job directory named by the `AllocationKey` (`idempotentAllocate: true`) |
| `find` | List sandboxes by label | Test for that directory (`findByKey: true`) |
| `stage` | Upload URL and tar | `tar` over the SSH channel |
| `exec`, `poll`, `kill` | Detached command, offset polling, `DELETE` command | Background process group with log files; signal the group |
| `collect` | Download URL | Read declared paths |
| `release` | Stop (`retain`) or delete (`discard`) | Remove the directory, or keep it with a deadline file |
| `usage` | Per-sandbox usage, `actual` | `none`: cost stays unknown |
| `remoteExpiry` | `true` (`ttlSeconds`) | `false`: the host lease alone bounds the job |

The capability differences surface only through `capabilities` and refusals,
which is what the shared conformance suite checks. #3105 proves it with an
independent offline test provider of this shape.

## Deferred

- **Interactive remote agents.** A provider-managed agent session, prompt API,
  SSH or desktop access, or a remote coding agent that writes back into the
  brain is a separate capability with its own design. Nothing in this slice
  makes a sandbox equivalent to a governed worker.
- **Scheduling across providers.** No fleet scheduler, automatic overflow
  placement or provider fallback. A refused or unavailable instance stays
  refused.
- **Snapshots as products.** Templates and saved snapshots are instance
  options, not contract operations.
- **A second shipped provider.** The SSH mapping above tests the surface; it is
  not a commitment to ship one.

## Still open

No question here waits on a maintainer ruling before #3105 starts. These
choices stay provisional and are settled within the bounds above by the issue
named, which records them with its code:

- The exact TypeScript names inside the seam, and the JSON field names of each
  operation's envelope (#3105, #3107).
- The standalone compute state directory's path and override (#3105).
- The Boat built-in's default credential variable, its `options` schema and
  the package's dependency declaration (#3106).
- Which hosted tool paths surface `brain_compute_*` and how approvals are
  presented (#3108).

A change to anything this record selected, such as the names in ruling 1, the
unknown-cost admission in ruling 4 or the refusal codes, needs a new ruling.

## Implementation ownership and proof

[#3105](https://github.com/schlessera/brain-kit/issues/3105) owns the seam,
the registry, admission, the job store, the lifecycle and the conformance suite.
[#3106](https://github.com/schlessera/brain-kit/issues/3106) owns the Boat
package. [#3107](https://github.com/schlessera/brain-kit/issues/3107) owns the
CLI, MCP and agent guidance.
[#3108](https://github.com/schlessera/brain-kit/issues/3108) owns hosted
admission, identity, Activity and credential isolation. These references
describe ownership, not progress.

All proof is keyless: a fake vendor transport, a fake clock and disposable
state. The cases that must fail when their guard is broken are lost create
responses, duplicate allocation, a lease that never expires, two processes
racing for the last concurrency slot or reserved budget, a credential reaching
a record or a sandbox environment, an undeclared path in a source bundle,
cleanup failure reported as success, and unknown cost reported as zero. No test
calls a vendor, and live qualification is a separately authorized operator
exercise.

Each implementation updates its integration-contract component and adds a
changeset in a `CONTRACT:` commit. All of them are additive. This record changes
neither the contract nor any package.

## Settled by #3105

[#3105](https://github.com/schlessera/brain-kit/issues/3105) settled the
choices "Still open" assigned to it, within the bounds above:

- **Names.** The seam's types are those in the
  [package component](../integration-contract/package-api.md#external-compute-seam-additive-3105).
  `ComputeContext` also carries the instance's parsed `options`, so one
  provider value serves several instances without sharing their settings. A
  built-in package exports `computeProvider` and may export `defaultKeyEnv`.
  The `boat` registry entry is reserved and reports `provider_unavailable`
  without importing anything: core may not name a package it does not
  declare, and that declaration is #3106's.
- **State directory.** Standalone, `$XDG_STATE_HOME/brain/compute/<brain key>/`
  (`~/.local/state` when unset), where the key is a hash of the brain's
  canonical root. `BRAIN_COMPUTE_STATE_DIR` or a host option overrides it.
  It is not a `brain.config` key, because the brain is agent-editable, and a
  directory inside the checkout is refused.
- **Serialisation.** Admission and each job are serialised by advisory locks
  the kernel releases when their process dies, so a dead holder never needs
  reclaiming and a live one is never mistaken for dead. A lock held past a
  bounded wait refuses with `concurrency_exhausted`.
- **Refusal mapping.** A lease above the provider's ceiling is
  `capability_unsupported`; above the instance's `lease.maxSeconds`, or a
  credential-shaped sandbox variable, is `policy_denied`; invalid instance
  options are `provider_unavailable`. No code was added.
- **Results.** Exit 0 with a declared artifact missing ends `failed` with the
  reason `artifacts_missing`. A record's cleanup fact may also be `none`
  (nothing was ever allocated) or `unknown` (an allocation may exist that
  could not be located).
- **Bounds without remote expiry.** A provider without `remoteExpiry` is
  bounded only by the host. Standalone, a job whose process stopped is bounded
  when it is next visited (status, cancel, collect or reconcile). Whether
  `brain compute run` stays attached until the job ends is #3107's choice.
- **A command that ended unseen.** Expiry and cancellation poll the command
  once before killing it. One that had already exited keeps its real exit:
  on expiry its artifacts are collected within the release allowance and
  recorded `not_collected` after it, and its state follows its exit. Neither
  can tell when it exited, because `CommandStatus` carries no time.
- **Recovery for release.** A lost allocation on an idempotent provider whose
  job is cancelled or expires gets one more allocate under the same key, only
  to learn the reference and release it.
- **Reconfigured instances.** A job records a hash of its instance's
  implementation, `options` and credential variable. While the configured
  instance hashes differently, the job gets no provider call and its status
  and reconcile entry say why. Limits such as the lease, slots and ceiling are
  outside the hash.
- **Partial cost.** A usage report with `partial` coverage is recorded and not
  settled, so the reservation stays held until a later report is complete.
  Unknown coverage is recorded as `usd: null` whatever amount came with it.

## Settled by #3106

[#3106](https://github.com/schlessera/brain-kit/issues/3106) settled the
choices "Still open" assigned to it, within the bounds above:

- **Dependency declaration.** `@schlessera/brain-compute-boat` depends at
  runtime on `zod` alone and imports `@schlessera/brain` for types only. Each
  package declares the other as an optional peer ranged `*`; the Boat package
  also takes core as a workspace dev dependency for the conformance suites.
  Core holds the specifier in an object literal and imports it through a
  non-literal `import()` only when an instance names `boat`, so the two
  optional peers form no runtime cycle and an install without the package
  still loads core. A missing package is `provider_unavailable` with the
  install it needs. No vendor SDK and no install script ship.
- **Default credential variable.** `BRAIN_COMPUTE_BOAT_API_KEY`, not the
  variable Boat's own CLI reads, so a broad key exported for that CLI is never
  used by a job without the operator naming it in `apiKeyEnv`. The adapter
  needs a scoped key with run-only actions (Boat's `ci` preset); account
  administration is never required.
- **Options.** `machine`, `from`, `environment` and `org`, all optional and
  validated strictly. A setup script, files at create, sandbox `env`, hosted
  ports and the API base URL are deliberately not options; the base URL is
  fixed and tests replace `ctx.fetch`. Without `environment` a sandbox is
  created with `noEnv`, also from a snapshot. Capabilities are fixed per
  provider, not per instance, because the seam's `capabilities` is a property
  of the implementation.
- **Lifecycle mapping.** Readiness is the sandbox state (`ready`, `idle`,
  `running`); setup and hydration are not waited for. A retained release
  stops without `force` and the adapter never resumes, so a stop never reads
  as a pause. Actual cost is the dollars of Boat's usage report, and unknown
  without one.

Boat's public documentation and OpenAPI description were rechecked on
2026-11-02 for this, without credentials. Where they differ, the OpenAPI
description was followed: it names the command conflict and machine errors
`boat_starting` and `boat_direct_failed` where the guides say
`sandbox_starting` and `sandbox_direct_failed`, so both are accepted; and
`dataExpiredAt` is the time stopped data was deleted, so a retention deadline
is computed from the stop, not read from it.

Review of #3106 refined two of #3105's rules:

- **Settling partial cost.** Once cleanup is `released` the sandbox accrues
  nothing more, so a `partial` report then is final: it is recorded as
  `partial` with its amount, a lower bound. A sandbox not yet released is read
  again, at most five times in all, and then settled with whatever the last
  read gave. The budget ledger takes a single amount, so only `complete`
  coverage settles with its dollars; `partial` and `unknown` settle as `null`
  (unknown), never as zero and never as the lower bound. An unknown read never
  replaces an earlier partial one. A reservation is therefore settled exactly
  once, whichever process reaches it. Boat's usage report is gone once its
  sandbox is deleted, so the adapter reads usage just before a discard and
  keeps that reading in process memory only; another process reads unknown,
  and both settle the ledger the same way.
- **One allocate request per key.** Every allocate under a job's key, a
  retry or the recovery for release, carries the same request. Remote expiry
  is the lease plus the release allowance, counted from the allocate call,
  rather than what remains of the lease, so a provider that rejects a reused
  idempotency key with a different body (Boat answers `409
  idempotency_key_reused`) never sees one.
## Settled by #3107

[#3107](https://github.com/schlessera/brain-kit/issues/3107) settled the
choices "Still open" assigned to it, within the bounds above:

- **Envelopes.** Success is `{ ok: true, ... }` with the operation's fields,
  and a refusal is `{ ok: false, error: { code, message } }` on both
  surfaces. A job's times are ISO 8601, and its view keeps the cleanup fact
  and cost apart from its state, with unknown cost `null`. The exact shapes
  are in the [CLI component](../integration-contract/cli.md#external-compute-additive-0450-3107).
- **One operation set.** `createComputeOps` in core builds the input schemas,
  calls the job service and shapes every envelope; the CLI command and the MCP
  tools only parse, print and map exit codes. MCP inputs are strict objects in
  snake case (`lease_seconds`, `artifacts[].max_bytes`), and the CLI parses its
  flags into the same object.
- **Callers.** The CLI is `{ kind: "cli" }` and the MCP server `{ kind: "mcp"
  }`, each with the operating-system user of its process as principal. No
  input carries a caller or provider identity.
- **Attached run.** `brain compute run` stays attached until the job ends,
  advancing it through `status`, so a standalone job without remote expiry is
  still bounded while the command waits. SIGINT or SIGTERM cancels it and
  reports the release; `--detach` returns once the command has started.
  `brain_compute_run` always returns once started, and the MCP server
  advances the jobs it started while it lives, cancelling nothing when it
  stops.
- **A stable roster.** The six tools are registered whatever the config says
  and refuse at call time, so configuring compute never changes a session's
  tool definitions.
- **Operator verbs.** `reconcile` and `abandon` (with `--confirm`) are CLI
  only; there is no seventh MCP tool.
- **Per-job retention.** A request may set `retain`; the instance's
  `retainOnRelease` is its default, and a provider that cannot retain refuses
  either with `capability_unsupported`.
- **Governance.** Plan and run apply the brain's governance policy
  `providers` rules to the declared source with the instance id as recipient,
  and an invalid policy file refuses them with `policy_denied`.
- **Guidance.** The `external-compute` core skill holds judgment only: local
  first, a provider for isolation or overflow, minimal sources, no secrets in
  argv or env, and every job ends with collect or cancel. Boat's upstream
  agent skills were reviewed through their documentation and are not vendored.
- **No admission inside a worker.** Until hosted admission lands (#3108),
  `plan` and `run` refuse with `policy_denied` when the process was started by
  a hosted turn or maintenance worker launch (`BRAIN_WORKER_DATA_ROOT` set).
  Such a worker already lacks provider credentials and a writable state home;
  the refusal makes that explicit instead of accidental.
- **Retention only narrows (review of #3107).** A job's `retain` may turn the
  instance's `retainOnRelease` off but never on: `retain: true` on an instance
  that does not set `retainOnRelease` refuses with `policy_denied`, so the
  operator's choice bounds what an agent can keep at the provider. A retained
  job counts toward `maxConcurrent` until its `retainedUntil` passes, since
  the provider still holds its data. This refines "Per-job retention" above.

## Settled by #3108

[#3108](https://github.com/schlessera/brain-kit/issues/3108) settled the
choice "Still open" assigned to it, within the bounds above, after the
maintainer ruled on four more questions on 2026-11-02.

### Rulings of 2026-11-02 on hosted admission

5. **One pool per compute state directory.** Slots and budgets are shared by
   every caller of one state directory. Hosted, it defaults to
   `<DB_PATH>.compute` (`BRAIN_UI_COMPUTE_STATE_DIR`), host operational state
   masked from workers. An operator who also runs `brain compute` from a shell
   points `BRAIN_COMPUTE_STATE_DIR` at the same directory to share one pool;
   otherwise the pools are separate.
6. **Built-in providers and operator-bound credentials only.** A hosted run
   accepts only built-in providers: an instance whose provider is a value is
   `provider_unavailable`, because the host never runs brain code. Its
   credential comes only from a variable the operator binds on the host,
   `BRAIN_UI_COMPUTE_KEYS="boat=BOAT_CI_KEY,BOAT_HEAVY_KEY"`, a built-in's own
   default variable being bound implicitly; an instance naming an unbound
   `apiKeyEnv` is `provider_unavailable`. Boat's `options.environment` is
   allowed on hosted runs: the operator accepts that the variables and secrets
   of that Boat environment reach its sandboxes. The CLI and a standalone MCP
   server are unchanged.
7. **Jobs outlive a normal turn end.** The host drives them until they settle,
   bounded by their leases, and a later turn of the same conversation may
   collect them. A cancelled, timed-out or budget-stopped turn, or one whose
   authority was revoked, cancels its jobs. Host shutdown cancels the jobs
   whose provider has no remote expiry.
8. **Each job is its own Activity root run** with a new additive `compute`
   origin, linked to its turn by attributes. An `uncertain` job stays open,
   flagged stuck.

### What the code settled

- **Tool paths.** Both first-party backends attach the six
  `brain_compute_*` tools to their host bridge (Claude
  `mcp__brain-ui__brain_compute_*`, pi plain names) in every interactive
  session's fixed roster; autonomous rosters never include them. Their inputs
  are core's strict operation inputs, so no caller, session, profile or
  credential field exists. The in-worker `mcp__brain__brain_compute_*` tools
  are disallowed in every Claude session, whatever the configuration, so the
  tool list never depends on it ([provider-history.md](provider-history.md)).
- **Configuration as data.** The host reads `brain config check --json`'s new
  `compute` summary in a credential-free strict worker that sees only the
  policy's protected paths, once per turn, as it reads the taxonomy
  (`readHostedComputeConfig`, `packages/ui-server/src/brain/compute-host.ts:980-992`). A
  provider value is reported by id only. A job keeps the instance
  configuration it was admitted under, so its driver never reaches another
  account however the brain changes later.
- **Order of checks.** Core's capability, lease, secret-free, source and
  data-to-provider checks run first, with the turn's frozen policy and the
  instance id as recipient. The host then refuses a provider value, an
  unbound credential, a `.env*` or Tier A source and any source or `cwd` the
  turn's provider masks hide. Then the approval: a run on an interactive
  typed turn shows a `command` card (instance, provider, lease, estimate or
  unknown, retention, source paths and hash, argv, environment names,
  artifacts and a taint notice), never remembered; an edited card is a
  refusal. Voice, a turn without a grant surface and a turn with no client
  connected refuse `approval_required` without a card. Each decision is a
  governance `outward_action` with action `compute_run` and the instance as
  target. Last, under core's admission lock, the host rechecks the turn's
  authority, core counts slots and the host ledger reserves.
- **Budget.** A reservation is one immediate SQLite transaction against the
  turn's frozen admission: refused when a scope is already blocked or a known
  reservation would reach a block, admitted with its cost unknown when the
  instance has no ceiling. It counts in every scope at its reserved amount
  until settled, then at its actual cost, or at its reservation when that
  stays unknown; a job with neither is an unknown run, never zero. A turn
  without a frozen admission, a failed ledger write or no ledger refuses
  `accounting_unavailable`. The receipt's coverage text is a closed enum on
  the wire, so it is unchanged.
- **Credentials.** Core gets an environment holding only the bound names.
  Values reach the provider call only and are redacted from every result. A
  bound name that `BRAIN_UI_SUBPROCESS_ENV_EXTRA`, the subprocess allowlist or
  an agent credential would forward to a child disables hosted compute and
  readiness names it; the launcher already drops every name it does not
  allow. Boat documents a per-sandbox port token that stays even without an
  environment; a command could print it into its output.
- **Output.** A collect returns artifacts by path and hash, never a host
  path, and its output is untrusted: the collect tool is a G6 taint source,
  `compute_output`.
- **Recovery.** At boot, before any turn, every unsettled hosted job is
  visited once and driven on. A job that settled while the host was down
  settles its reservation then, exactly once, whichever process reaches it.
- **Readiness.** `/api/status` `runtime.compute` reports the state directory
  and its mask, each binding with its presence and whether it would reach a
  worker, the built-in package and its remote expiry, and the instances the
  last turn read, without calling a vendor.

Running hosted compute is not a claim that a sandbox is a governed worker.
The operator page is [hosting/external-compute.md](../hosting/external-compute.md).

### Corrections from the #3108 review

These refine the notes above; where they differ, these hold.

- **Ruling 6: an implicit default needs a listed provider.** A built-in's own
  default variable is bound only for a provider the operator lists in
  `BRAIN_UI_COMPUTE_KEYS`; listing it alone (`boat` or `boat=`) binds just
  the default. Unset, the host binds no credential at all, so readiness is the
  same from boot and does not change after the first turn loads a built-in.
- **One credential per call.** Core no longer gets every bound name. Each
  provider call, health included, gets only its own instance's bound
  variable, and the host refuses an instance before calling its provider, so a
  key bound for one provider never reaches another.
- **Ruling 7: a job belongs to its conversation.** A later turn of the same
  session may check, cancel or collect a job whichever principal the host
  authorized for that session, so a re-login keeps its jobs; the change of
  principal is recorded on the job's Activity run as a `compute_principal`
  event. Another session still gets `job_unknown`. Core's caller match for
  hosted callers is the session; CLI and MCP still match kind and principal.
- **Ruling 7: cancellation covers a run still being admitted.** The host
  records a turn as cancelled before it looks for the turn's jobs, and a run
  whose record appears after that, or whose turn lost its authority while
  core reserved, is cancelled before anything is allocated (core's run hook
  may answer `cancel`). `cancelTurn` also waits for the turn's compute calls
  in flight and sweeps again.
- **Settled means the reservation too.** Every compute job envelope gains
  `settled`: terminal, cleanup final and its cost settled against the
  caller's budget. The host treats a job as settled only then, and only once
  its own ledger write has committed; a failed write leaves the job open and
  tracked, and is retried. A job the host abandons settles its reservation as
  unknown, and at boot a reservation left without a job record settles as
  unknown; both keep counting at the reserved amount, never zero. A job the
  driver cannot advance after repeated failures keeps its reservation active
  and its run flagged stuck, with the cause in Activity. Under #3815 it keeps
  visiting at the capped interval until settlement can be confirmed, without
  requiring a restart or another admitted turn.
- **Activity over HTTP.** `GET /api/activity/runs` and
  `GET /api/activity/runs/:runId` return `compute` runs only to a request that
  declares the capability, as the live stream does.
- **An unconfigured host is unchanged.** The host creates and masks the
  compute state directory only when a credential is bound in
  `BRAIN_UI_COMPUTE_KEYS` or the directory already holds earlier state, and
  imports core at boot only then or when a hosted job is unsettled. A host
  without compute boots exactly as it did before hosted compute existed;
  readiness says no credential is bound.
