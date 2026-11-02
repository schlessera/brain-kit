# Extending: compute providers

A `ComputeProvider` allocates a disposable sandbox, runs commands in it,
returns their results and releases it. It runs no model and holds no
conversation. It is what a configured `compute.providers` instance runs on,
and it is distinct from model providers, agent runners and agent backends.
The contract, its terminology and the maintainer's rulings are in
[decisions/external-compute.md](../decisions/external-compute.md).

The provider maps vendor transport only. Core owns everything else: the job
record and its lease, admission, identity, the source and artifact manifests,
retries, recovery and cleanup. A provider never sees or mutates a job.

## The interface

From `@schlessera/brain` (`export interface ComputeProvider`, `packages/core/src/lib/seams.ts:538-560`),
with its capabilities (`export interface ComputeCapabilities`, `packages/core/src/lib/seams.ts:299-317`):

```ts
export interface ComputeProvider {
  readonly id: string;
  readonly capabilities: ComputeCapabilities;
  configSchema?: ComputeOptionsSchema;   // a zod schema fits; validates `options`
  health(ctx): Promise<ComputeHealth>;   // allocates nothing
  allocate(req, ctx): Promise<AllocateOutcome>;
  find?(key, ctx): Promise<FindOutcome>;            // iff capabilities.findByKey
  stage?(sandbox, source, ctx): Promise<StageOutcome>;   // iff capabilities.stage
  exec(sandbox, command, ctx): Promise<ExecOutcome>;
  poll(handle, ctx): Promise<CommandStatus>;
  kill(handle, ctx): Promise<KillOutcome>;
  collect?(sandbox, request, ctx): Promise<CollectOutcome>; // iff capabilities.collect
  release(sandbox, mode, ctx): Promise<ReleaseOutcome>;    // "discard" | "retain"
  usage?(sandbox, ctx): Promise<CostObservation>;        // iff usage is "actual"
}
```

Write one with `defineComputeProvider` and pass it by value:

```ts
import { defineConfig } from "@schlessera/brain";
import { sshCompute } from "brain-compute-ssh"; // hypothetical package

export default defineConfig({
  compute: {
    providers: {
      "ithaca-host": {
        provider: sshCompute({ host: "ithaca.example", workRoot: "/srv/jobs" }),
        lease: { maxSeconds: 1800 },
        maxConcurrent: 4,
      },
    },
  },
});
```

The one built-in name is `boat`, which resolves the separate first-party
package `@schlessera/brain-compute-boat`, so vendor transport never ships
inside core. Core declares it as an optional peer; an instance naming `boat`
without the package installed is `provider_unavailable` and names the install
it needs. A built-in package is loaded only when an instance names it; it
exports `computeProvider` and may export `defaultKeyEnv`, the variable an
instance without `apiKeyEnv` reads (`export async function loadComputePackage`, `packages/core/src/lib/registry.ts:437-461`).
Resolution gives each instance its own options and secret
(`export async function resolveComputeInstance`, `packages/core/src/lib/registry.ts:515-561`).

## The Boat built-in

`@schlessera/brain-compute-boat` is the shipped worked example of this guide.
It uses plain `fetch` through `ctx.fetch`, imports `@schlessera/brain` for
types only and depends on nothing but `zod`. Its capabilities are fixed:
detached commands, idempotent allocation and lookup by key, staging up to
256 MiB, collection up to 50 MiB per file, retention for 14 days, a 30-day
remote auto-stop and actual usage. Its default key variable is
`BRAIN_COMPUTE_BOAT_API_KEY`, and its `options` are `machine`, `from`,
`environment` and `org`. It creates every sandbox without Boat's account
environment unless an instance names one, never treats a stop as a pause and
never resumes a sandbox. The [package README](../../packages/compute-boat/README.md)
documents the key actions it needs, the full mapping, the error table and
Boat's retention, command-history and cost limitations. Its tests run both
conformance suites below against an in-process fake of Boat's API
(`packages/compute-boat/tests/contract.test.ts`).

## What a provider promises

- **Outcomes, not exceptions.** Every method resolves to a typed outcome for
  expected vendor states. `refused` and `failed` mean nothing happened;
  `uncertain` means the effect happened or may have happened and the answer
  was lost. A transport failure whose effect is unknown is `uncertain`, never
  a guessed success or failure. A throw is treated as `uncertain`.
- **Capabilities are honest.** Optional methods exist exactly when their
  capability says so. Core refuses a job that needs a capability the
  instance lacks with `capability_unsupported` before any effect.
- **Allocation keys.** `allocate` receives an `AllocationKey` the host wrote
  durably first. With `idempotentAllocate`, the same key returns the same
  sandbox. With `findByKey`, `find(key)` locates an allocation whose response
  was lost. A provider with neither leaves a lost allocation unresolved; core
  then never allocates again for that job.
- **Staged files carry bytes, not modes.** A `SourceBundle` file has a path,
  a hash and its bytes; it carries no file mode, so a provider stages every
  file as a regular, non-executable file. A job runs a staged script through
  its interpreter (`sh build.sh`), not as `./build.sh`.
- **Releasing twice is not an error.** A second `release` of a released
  sandbox reports `released`.
- **Exit status is kept.** `poll` reports the exit code as the command
  returned it, and a command the host killed reads `killed`.
- **The context is per call and per instance.** `ctx` carries the instance
  id, its parsed `options`, its secret, an abort signal, a deadline in
  epoch milliseconds, a replaceable `fetch` and a logger that redacts the
  secret. Two instances of one implementation never share options or a
  secret. A call whose signal is already aborted settles promptly.
- **The secret stays on the host.** Never forward it into a sandbox's
  environment, a reference's `data` or an outcome. Commands receive only the
  explicit `env` allowlist the host passes.
- **Unknown cost is `null`.** A `usage` report with unknown coverage has
  `usd: null`, never zero; core records it that way whatever the amount. A
  `partial` report is kept as a lower bound. While the sandbox is not
  released it is read again, up to five reads in all; once the sandbox is
  released, or the reads are spent, the reservation is settled once as
  unknown (`null`), never with the lower bound.
- **`remoteExpiry`.** A provider that enforces its own auto-stop receives
  `remoteExpirySeconds` — the host lease plus the release allowance — as a
  backstop for a host that dies. Every allocate under one key, retry or
  recovery, carries the same request, so a provider may check its
  idempotency key against the request body. Without it, only the host bounds a job: in
  standalone use, a job whose host process stopped is bounded when it is next
  visited: a status, cancel or collect call on it, or a reconcile.

## The job lifecycle

Core drives every job through `admitted`, `allocating`, `staging`, `running`,
`collecting` and `releasing`, with `uncertain` whenever an effect's outcome
is unknown. Before each provider call it writes an intent receipt, and after
it an outcome receipt, so a process that dies mid-call leaves a record that
reconciliation resolves without repeating a non-idempotent effect
(`private async resolveUncertain`, `packages/core/src/lib/compute/lifecycle.ts:368-402`):

- A lost allocation is retried under the same key when the provider is
  idempotent, looked up when it can find by key, and otherwise left
  `uncertain`. An empty lookup never provisions. When the job is cancelled or
  its lease ends first, an idempotent provider receives one more allocate
  under the same key, only to learn the reference so it can be released.
- A lost exec is never run again. The job stays `uncertain` until its lease
  ends, then its sandbox is released and its exit is `unknown`.
- Lease expiry polls the command once, then kills it if it still runs,
  collects nothing further and releases. A command that had already exited
  keeps its real exit; its artifacts are collected within the release
  allowance and recorded `not_collected` after it.
- Cancellation polls the same way, kills a running command and releases, and
  says whether release was confirmed. A command that had already exited keeps
  its real exit.
- A job whose instance was reconfigured after it started (other `options`
  or another credential variable) gets no provider call until that
  configuration is restored; status and reconcile report why.

Terminal states are `succeeded`, `failed`, `cancelled`, `expired` and
`abandoned` (an operator accepted an unresolved `uncertain` outcome). Every
terminal record keeps its cleanup fact — `released`, `retained`,
`release_failed`, `none` (nothing was allocated) or `unknown` (an allocation
may exist that could not be located) — apart from its state. A failed
release is retried with backoff and keeps the instance's concurrency slot
until it succeeds. Exit 0 with a declared artifact missing ends `failed` with
the reason `artifacts_missing`, keeping the exit code and the artifacts that
were collected.

Job records, receipts and artifacts live in the compute state directory
outside the brain and outside `brain.db`
([configuration](../configuration.md#compute)). Admission and each job are
serialised across processes by kernel-released locks, so a CLI run and a
hosted run cannot both take the last slot, and a lock whose process died is
free again without guessing.

## Conformance

`@schlessera/brain/testing` publishes two suites. Run both against your
provider with a fake transport or disposable local resources; never a vendor
and never a real key:

```ts
import { describe, expect, test } from "bun:test";
import { runComputeLifecycleContract, runComputeProviderContract } from "@schlessera/brain/testing";

const harness = {
  name: "ssh",
  provider: () => provider,
  commands: {
    exit: (code: number) => ["sh", "-c", `exit ${code}`],
    sleep: (seconds: number) => ["sleep", String(seconds)],
    write: (path: string, text: string) => ["sh", "-c", 'printf "%s" "$1" > "$0"', path, text],
    printEnv: () => ["env"],
  },
  liveSandboxes: () => countLiveSandboxes(),
  loseNextResponse: (method: "allocate") => fake.loseNext(method),
  failNextTransport: (method: "allocate" | "poll") => fake.failNext(method),
  stateDir: () => makeDisposableDirectory(),
};

runComputeProviderContract(harness, { describe, test, expect });
runComputeLifecycleContract(harness, { describe, test, expect });
```

The provider suite checks well-formed capabilities, optional methods against
capabilities, that health allocates nothing, exit codes, kill, double
release, idempotent keys, lost allocation responses, staging and collection
caps, transport failures, prompt settling on an aborted signal, that the
secret reaches neither the sandbox nor an outcome, and that unknown cost is
`null`. The lifecycle suite drives the provider through core's job lifecycle
and checks success, a kept nonzero exit, cancellation, unknown cost and that
no record holds the secret. This repository runs both against two offline
implementations with different capabilities, in
`packages/core/tests/compute-contracts.test.ts`.
