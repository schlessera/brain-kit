# Hosted proof without a merge bottleneck

The maintainer selected this policy on 2026-10-09 under
[#1326](https://github.com/schlessera/brain-kit/issues/1326), after the public
repository moved to GitHub Actions. Standard hosted runner minutes are free;
queue delay, ready-to-merge elapsed time and cancellation/repeated work now
matter more than summed paid consumption. This supersedes #1305's requirement
for complete mandatory local proof and packaging-before-verification scheduling.
Every test, offline boundary, image/runtime pin and behavioral assertion remains.
The earlier #1321 exception was one PR's ruling; this is the general policy.

## Local feedback and authoritative proof

`bun run check:pr --base origin/main` runs local lint/leakage, metadata,
contribution changeset and affected fast invariants, including uncommitted work.
It does not require Docker, Chrome or namespaces and does not duplicate complete
packaging, strict types or full browser/runtime proof. Agents still supply
focused failing-first and restored mutation receipts, debug failures and review
visual results. A test failure is not excused by moving its execution.

CI supplies authoritative complete repeatable proof on ready PRs. Complete
unit/integration discovery includes affected workspaces and every reverse
dependant, plus root tooling tests. Global/unknown inputs expand to complete
default discovery. Newly added files are discovered, not admitted through a
fixed allowlist. Shipped changes retain all packed-consumer probes; selected
strict types remain complete. UI inputs retain every pinned visual/accessibility/
pointer project, layout/offline/endurance file and editorial verification.
Relevant runtime work retains real Chrome, Claude permission/enforcement,
native delegation/capability/Haiku probes, measurement isolation and shared
process cleanup. Native probes run against loopback fixtures without live keys.
The Linux runner setup retains the existing ephemeral namespace prerequisite;
the test/preload and offline namespace guards remain enabled.

Complete local commands remain available: `check:pr --full` runs the affected
full inventory and `check:pr --all` runs every category for releases or diagnosis.
Neither is mandatory for an ordinary contribution with complete passing hosted
proof. They are not substitutes for automatic event/checkout evidence.

## Scheduling and selection

Drafts run cheap rejection/metadata gates only. Marking ready selects complete
proof; subsequent synchronize events reselect actual changed inputs. Batch
intermediate pushes. Title/label edits run the separate contract gate, not long
proof. Main commits keep independent SHA concurrency groups; obsolete heads of
one PR share a cancellable group. Different PRs never cancel one another.

After cheap gates, packaging, strict verification, unit shards, runtime probes,
browser shards, layout/endurance shards and captures start independently.
There are four measured-cost unit partitions and two browser/layout partitions,
with full coverage assertions and original per-browser file concurrency bounds.
The first two-unit-partition hosted run reached its 20-minute budgets while
still making progress. Completed-file observations in
`scripts/unit-shard-observation.json` update underestimated weights; unfinished
files are not passing proof. Four partitions retain the deadlines and reduce
that measured critical path. Browser sharding uses the committed per-project/
file table under #1082, rather than grouping every pointer variant of a costly
file in one hash/count bucket. Unknown specs retain positive defaults, every
spec is assigned once, and unsharded discovery is unchanged. Refresh explicitly
with `bun scripts/refresh-browser-costs.ts <run-id> <attempt>`; reviewed CI
reports are measurement inputs, never runtime dependencies.
A complete unit selection already includes cheap invariants, so CI does not run
that subset twice. No independent test/type job waits for packaging. The final
`proof` gate examines every selected job: success is required; missing output,
failure, cancellation and unexpected skips cannot pass. Only explicit planner
exclusions permit skips. Exhaustive scheduled/manual runs detect selection drift
and remain supplementary to affected pre-merge proof.

Retain actual tested head/base/checkout identities, commands, attempts and
artifacts. Inspect new main commits before refreshing. Unrelated advancement
alone does not demand a rebase or repeat long suites. Reuse is justified only
when the complete suite inputs, dependency closure, fixtures and harness are
unchanged and recorded evidence establishes that fact; unknown/global changes
require fresh proof. There is no generic passing-result cache. The earlier run
still names its own tree, not a later combined checkout. Required branch rules
and actual merge-result parent/tree validation remain binding.

### Retaining complete browser domains

Under #1333, ready-PR metadata can retain both shards of a complete browser or
layout domain from up to three recent successful automatic runs of that same
contribution. Unit, types, packaging, native runtime and editorial checks remain
fresh: their Git-sensitive or broader process inputs do not have an admitted
independent domain. Main pushes and scheduled/manual runs execute fresh proof.
There are no chains through previously retained/skipped jobs.

Vitest's installed `list --filesOnly --json` discovers actual project/file
ownership without collecting suites. Shared files remain inputs to both
domains; `recordings-tray.offline.tsx`, for example, belongs to layout and rail
projects. The complete two-shard spec inventory/order and measured partition,
runner image/version, and every tracked Git blob/path/mode are fingerprinted.
Only the content of unreferenced, unexported opposite-domain test leaves is
excluded. Their paths/modes stay hashed. Reference closure includes strings,
helpers, fixtures and symlink targets; all unknown files, shared fixtures,
source, dependency manifests/lockfiles, configuration and runtime/image pins
stay hashed. New discovery and changed ownership expand conservatively.
The installed TypeScript compiler's expanded build inventory and the explicit
CSS scan roots must also exclude those foreign leaves; unknown build/scan
configuration retains fresh execution.
Unknown dynamic spec imports, Git-dependent spec inputs, alternate runtime
contexts or unavailable discovery do not qualify for retention.

Each source shard must have an actual successful fresh execution step, a
matching GitHub Actions check, one post-success receipt, and a checkout log
for the same PR. Run/attempt/job/check IDs and immutable commit/tree/parents
are verified against the [read-only GitHub job/check APIs](https://docs.github.com/en/rest/actions/workflow-jobs).
Both source and current Git
trees are recomputed; artifact or PR metadata claims alone cannot authorize
retention. The source workflow must be identical. The current-head aggregate
independently repeats receipt validation before accepting a selected domain's
intentional skip, retaining the original evidence's identity in the ledger.
Missing, failed, cancelled, held, malformed or mismatched evidence cannot pass.

CI adds only `actions: read` and `checks: read` for those APIs; ordinary fork execution retains
its read-only token, no secrets and nonpersisted checkout credentials. Lookup
is limited to three runs, 32 API requests with a 45-second API budget, bounded response sizes and
finite logs; unavailable evidence falls back to fresh execution. The aggregate
fails closed if previously admitted retention is no longer verifiable.
Record actual retained runner time and lookup/aggregate costs on a controlled
base advancement. This preserves runner consumption without claiming that
unchanged browser proof removes a remaining long native critical path.
Discovery has a 15-second timeout; a missing immutable Git object has an
eight-second bounded fetch. Runner image context comes from the image's
[recorded environment](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-environment.sh).

## Measuring the critical path

Record queue wait, job elapsed times, ready-to-merge duration, cancelled attempt
time and repeated work after base advancement. Historical Depot samples (198
terminal workflows, 43% cancellation consumption, median successful 21-minute
elapsed/93-minute summed time) explain the former policy; they are not hosted
GitHub benchmarks. Measure the new pinned runner before changing shard counts,
browser file concurrency or test deadlines. Free runner minutes do not remove
account concurrency limits. Preserve diagnostic reports and failure images,
with bounded artifact retention. Fix flaky behavior; never rerun a real failure
or shorten its assertion merely to obtain green.

The repository is user-owned, so native GitHub merge queues are unavailable.
Do not invent a queue or require ownership migration as part of this change.
The existing matching-head merge plus relevance assessment remains in use.

## Historical measurement and upstream guidance

The following guidance records the paid-provider investigation which motivated
#1305. Its recommendations to keep idle/browser work local and serialize shorter
jobs are superseded above; its measurements and isolation cautions retain their
historical context.


Depot [bills by the second, weighted by sandbox size](https://depot.dev/docs/ci/overview).
Compare the sum of `elapsed seconds × plan-minutes multiplier` across every
attempt, including retries and cancellations. A four-CPU sandbox consumes twice
the plan minutes of a two-CPU sandbox; it must finish in less than half the time
to reduce consumption. Use [job CPU/memory and step timings](https://depot.dev/docs/ci/observability/depot-ci-metrics)
to distinguish spare CPU from memory pressure or real-time waiting. An idle
ten-minute deadline should remain a local check, not gain more workers or CPUs.

[Bun's parallel runner](https://bun.com/docs/test/parallel) offers file workers
with `--parallel=2`; `--no-isolate` retains each worker's module registry and
preload rather than reevaluating them for every file. Benchmark that against
ordinary processes with the offline guard intact. `test.concurrent` overlaps
async tests within one file but shares globals and hooks; it does not add CPU
workers and is unsuitable as a blanket setting for mutable mocks or fixtures.
Record per-file durations during a required local run with
`bun run test --timings=tmp/bun-test-timings.json --update-timings`. That run still
discovers the complete suite. Duration data should guide balancing rather than
file counts; measurements must come from comparable runtime/resources.

[Depot supports parallel steps](https://depot.dev/docs/ci/how-to-guides/parallel-steps)
with cancellation on failure. Our bounded process queue also works on fork
GitHub Actions and locally, shares setup, and terminates child process groups
when interrupted. Independent commands must not write the same outputs.

[Depot's sharding guide](https://depot.dev/blog/accelerating-test-suites) recommends
increasing concurrency on one machine first and keeping setup a small fraction
of each shard. For unchanged test work `W`, setup `S` and `k` equally sized
runners, ideal summed time is `W + kS`, compared with `W + S` on one runner.
Use shards only when measured gains justify that overhead. Earlier completion
can avoid some cancellations, so cancellation waste depends on push timing;
compare consumed attempt time rather than assuming every shard makes it worse.

[Custom images](https://depot.dev/docs/ci/how-to-guides/custom-images) can remove
expensive browser/OS/toolchain setup. [Durable cache disks](https://depot.dev/docs/ci/how-to-guides/cache-disks)
can reuse caches without archive transfers, but concurrent writers need separate
paths or immutable entries. Neither is the first cost lever here: inspected
dependency installs were short, and expensive automatic browser jobs have moved
to required local checks. Do not cache a passing test result as a substitute
for proving the changed checkout.
