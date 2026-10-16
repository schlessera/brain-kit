# Hosted proof without a merge bottleneck

The maintainer selected this policy on 2026-10-09 under
[#1326](https://github.com/schlessera/brain-kit/issues/1326), after the public
repository moved to GitHub Actions. Standard hosted runner minutes are free;
queue delay, ready-to-merge elapsed time and cancellation/repeated work now
matter more than summed paid consumption. This supersedes #1305's requirement
for complete mandatory local proof and packaging-before-verification scheduling.
Every test, offline boundary, image/runtime pin and behavioral assertion remains.
The earlier #1321 exception was one PR's ruling; this is the general policy.

## Browser proof input ownership

The maintainer selected D/A/A under [#2125](https://github.com/schlessera/brain-kit/issues/2125)
on 2026-10-16: discover repository static imports and validate explicit declarations
for spawned processes, generated entrypoints, file reads, assets and CSS/build inputs.
Browser, layout, endurance and captures each use their applicable combined closure.
Captures use their own entrypoints and declarations. A selected category runs in full;
this changes category selection, never its internal case inventory or shard coverage.

Declarations live alongside the harness in `packages/ui-kit/tests/proof-inputs.json`
and `scripts/captures/proof-inputs.json`. Each binds an exact owner call expression
to nonempty repository targets. Targets must exist and participate transitively;
directories also own newly added descendants. Missing, duplicate, stale, unused,
escaping or unsupported inputs retain the previous broad selection. Exact source
matching detects a changed call site; it does not prove an arbitrary runtime target
is bounded. Do not declare an owner as its own target to conceal unknown inputs.

Runtime-selected configuration/modules and backend imports can prevent a closed
category. That is a conservative result, not permission to discard an edge. The
shared Vitest config imports the dispatch command; its real application fixture
reaches every current server route. A synthetic unrelated-route negative therefore
does not demonstrate savings for any existing route. Fixed spawned fixture and
corpus paths are declared independently of these runtime-variable edges.

Global dependency/tooling changes retain complete selection. Main pushes retain
complete affected proof. Scheduled and manual runs remain exhaustive as an
independent detector of omitted inputs; they do not replace exact candidate proof.
The same immutable 100-PR replay must identify every newly omitted browser category
and its closure evidence. Zero reductions is a valid observed result, without a
speedup claim or an inferred narrower harness.

## Local feedback and authoritative proof

`bun run check:pr --base origin/main` runs local lint/leakage, metadata,
contribution changeset and affected fast invariants, including uncommitted work.
It does not require Docker, Chrome or namespaces and does not duplicate complete
packaging, strict types or full browser/runtime proof. Agents still supply
focused failing-first and restored mutation receipts, debug failures and review
visual results. A test failure is not excused by moving its execution.

CI supplies authoritative complete repeatable proof on explicit ready-candidate requests. Complete
unit/integration discovery normally includes affected workspaces and every reverse
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


Root `tests/**`, `scripts/**`, `experiments/**` and `website/**` now use a
conservative reverse reference closure to select root and package test consumers,
plus the reviewed category table in `scripts/ci-plan.ts`. Root test leaves select
themselves. Narrow unit inventories include the tooling fast invariants exactly
once: when complete unit proof is selected, verify does not repeat the fast
subset. Package changes still discover all root tests alongside affected packages.
Unreadable inputs, outside symlinks, conflicting mappings and inputs without a
recognised test/category consumer remain global. Lockfiles, root manifests,
changeset configuration, workflows and unknown roots remain global. Exhaustive
and event/candidate/aggregate requirements are unchanged.

Complete local commands remain available: `check:pr --full` runs the affected
full inventory and `check:pr --all` runs every category for releases or diagnosis.
Neither is mandatory for an ordinary contribution with complete passing hosted
proof. They are not substitutes for automatic event/checkout evidence.

> **2026-10-10 — Implementation context (complete default discovery above).**
> Under the maintainer's 2026-10-09 ruling on
> [#1386](https://github.com/schlessera/brain-kit/issues/1386), tests that
> exercise only measurement and eval harnesses moved to `experiments/`, which
> default discovery, `check:pr` (including `--full` and `--all`) and hosted unit
> proof do not select. Release preparation runs that whole tier with
> `bun run test:experiments` after `bun run version`, and `bun run release`
> refuses a candidate without its matching receipt
> ([experiment-tier.md](experiment-tier.md)). This narrows only where
> experiment-only tests run. Every product, security, contract, runtime,
> offline-boundary and release-tooling test, including measurement isolation,
> stays in the default discovery and the guarantees this record describes.

## Scheduling and selection

Under the maintainer's 2026-10-14 ruling in #1849/#1854, drafts run cheap
rejection/metadata gates only. Opening or reopening a ready PR, or marking a
PR ready (`ready_for_review`), explicitly requests complete affected candidate
confirmation. A ready PR's `synchronize` event runs affected strict types and
curated fast invariants; packaging, complete unit/native/browser/layout/capture
proof and endurance wait for confirmation. Its `proof` check deliberately fails
with the action needed: convert to draft, finish pushes, then mark ready again.
Fast feedback being green is useful, but never sufficient merge evidence.
The request belongs to one event, not a label that can approve later commits.
Main pushes still execute complete affected proof. Scheduled and manual runs
execute exhaustive discovery with a distinct aggregate check name, so they
cannot impersonate a PR's candidate confirmation. Title/label edits run the separate contract gate, not long
proof. Main commits keep independent SHA concurrency groups; obsolete heads of
one PR share a cancellable group. Different PRs never cancel one another.

After cheap gates, packaging, strict verification, unit shards, runtime probes,
browser shards, layout shards, a separate endurance job and captures start independently.
There are four measured-cost unit partitions and two browser/layout partitions,
with full coverage assertions and original per-browser file concurrency bounds.
The first two-unit-partition hosted run reached its 20-minute budgets while
still making progress. Completed-file observations in
`scripts/unit-shard-observation.json` update underestimated weights; unfinished
files are not passing proof. Four partitions retain the deadlines and reduce
that measured critical path. After #1298 added the pinned native evaluation
controls, run38045497058/attempt1 again exhausted the outer20-minute cap in
three progressing unit partitions; the fourth finished in908.46seconds.
Completed-file observations refresh the same cost table, while unfinished
SDK groups retain explicit lower bounds without being passing proof. #1485
raises only the bounded outer unit-job capacity to30minutes, preserving
four partitions, every discovered test, all per-test/native deadlines and
browser/product budgets. Queue, cancellation and elapsed evidence remain in
the observation record. Browser sharding uses the committed per-project/
file table under #1082, rather than grouping every pointer variant of a costly
file in one hash/count bucket. Unknown specs retain positive defaults, every
spec is assigned once, and unsharded discovery is unchanged. Refresh explicitly
with `bun scripts/refresh-browser-costs.ts <run-id> <attempt> [browser|layout]`
(the default remains browser). Each domain retains its own run/attempt/job,
checkout/tree/parent and pinned-image provenance. Refresh requires both fresh
successful jobs from a successful CI run, matching actual checkouts, complete
reported project/file coverage and source/image attribution; cancelled,
partial or retained-only proof supplies no measurements. Refreshing one domain
preserves the other's costs and provenance. Reviewed CI reports are measurement
inputs, never runtime dependencies. Layout refresh admits ordinary
`ui-react-layout` measurements; `ui-react-endurance` remains a separate mandatory
fresh job and never becomes an ordinary browser/layout weight. Requalify timing
inputs after scenario ownership changes: the former combined recording-file
measurement includes endurance and is not its current ordinary-layout cost.
Two layout shards, per-project serial execution and all deadlines remain unchanged.

Hosted unit partitions use a queue capped at two serial Bun test processes
(`scripts/unit-workers.ts`), or one when only one file is selected. Native
Bun `--parallel=2` failed all four hosted partitions in
[run 38905715338](https://github.com/schlessera/brain-kit/actions/runs/38905715338):
DOM cleanup, an import initialization cycle and shared build output require
separate ownership. The queue gives each process a detached source checkout,
private frozen dependency copies, a private build and its existing workspace
lease. Its mode-0700 container sits beside the original checkout, outside
host `/tmp` so native workers can still load their runtime. A private mount
binds only that process's maintenance ledger; children still share its original
limits. Setup capabilities are dropped and the caller's umask is restored.
Discovery, per-test deadlines, offline preload, browser concurrency and the
outer job budget remain unchanged. Combined JUnit and timings must cover the
selected files exactly; worker artifacts retain partial failure diagnostics.

[Run 38913463131](https://github.com/schlessera/brain-kit/actions/runs/38913463131)
at actual source `b8a75225` supplies the serial baseline: 961 files, 13,512 cases,
28 skips and no TODOs; the longest proof took 1,402.32 seconds, used 2,227.51
VM CPU seconds and peaked at 5.48 GB on a 16.77 GB runner (11.29 GB headroom).
All four queued arms failed because their checkout location hid native source
under `/tmp` and their setup umask changed test file modes. Those timings do
not establish a speedup. Restoring caller permissions and native source
visibility has real failing/restored runtime controls.

The corrected N=2 queue completed all four arms of
[run 38917533458, attempt 1](https://github.com/schlessera/brain-kit/actions/runs/38917533458)
at actual source `9e7a178f28025648109c6e2fb23d2bf325f813ed`, tree
`a3db5f93d51b4159bfa7e5bf4046ab3872b85331`. Their reconciled JUnit/timing
inventories contain exactly 961 distinct files and 13,512 cases: 13,484 pass,
28 skip, zero TODO and zero failures, matching the earlier serial totals.
The four complete measured proof steps took 852 / 962 / 989 / 987 seconds;
VM resource receipts record 2.31 / 2.87 / 2.43 / 2.75 average busy cores and
5.17 / 3.57 / 6.04 / 4.22 GB sampled peaks. The highest peak leaves 10.73 GB
of the 16.77 GB runner available. A test-only external-fetch mutation failed
inside queue worker 2 with the offline guard assertion; the guard job restored
the production source. The experiment run as a whole failed its separate
workflow-policy lint because its measurement-only workflow pins another
checkout; that is not a passing production CI run.

The observed longest step is 989 seconds versus the earlier 1,402 seconds,
about 29% shorter. The sources differ only in the owned worker harness and
fixture corrections, and runner variation is uncontrolled: this is a measured
comparison, not literal same-SHA count proof or a qualified throughput claim.
N=2 remains the bounded candidate. That earlier comparison retains its original
source limitation.

The four serial arms in
[run 38933790923, attempt 1](https://github.com/schlessera/brain-kit/actions/runs/38933790923)
now supply the literal same-source comparison at `9e7a178f` and the same tree.
All four actual checkout logs agree with their checkout/resource artifacts.
Independent reconciliation of both arms' selected files, top-level JUnit
file suites, individual cases, report summaries and timings proves identical
961-file inventories and counts: 13,512 cases, 13,484 pass, 28 skip, zero
TODO/failures. Each partition retains 231 / 242 / 243 / 245 files. The four
serial complete measured steps took 1,014 / 1,169 / 1,177 / 1,200 seconds,
versus 852 / 962 / 989 / 987 seconds for N=2: the longest selected step is
about 18% shorter at this source. VM-receipt elapsed time is separately
1,007.80 / 1,161.67 / 1,175.03 / 1,193.28 seconds for serial and
845.24 / 955.70 / 980.70 / 984.59 for N=2; step time also includes cold
Chrome/startup around those measured phases.

Serial receipts record 1.18 / 1.61 / 1.49 / 1.58 average busy cores and
4.83 / 3.31 / 6.23 / 3.30 GB sampled VM peaks; the tightest headroom is
10.53 GB. The same-source N=2 peaks and cores above remain within the
same 4-vCPU, 16.77-GB envelope. These are sequential experiments on separate
runner instances, with uncontrolled queue/cold-start/host variation, not a
randomized estimate or production-main qualification. Serial jobs waited
2,950–3,005 seconds from dispatch to start; their 4,209-second event-to-final
completion includes those queues, while simultaneous queues are not added
as elapsed critical path. No arm was cancelled or retried for this comparison.

Both measurement workflows are evidence vehicles, not production confirmation;
the N=2 experiment's independent lint failure is unchanged. Two consecutive
qualifying exhaustive/main passes remain obligations in
[#2121](https://github.com/schlessera/brain-kit/issues/2121), independently of
this now-completed same-source count comparison. Dependency copies and private
builds count in proof time and sampled VM resources; setup/install and queues
remain separate step measurements. No deadline, shard count or N changed here.

Unit weights have the same explicit reviewed path:
`bun scripts/refresh-unit-costs.ts <run-id> <attempt>`. It requires all four
successful exhaustive unit jobs and binds actual checkout logs, immutable
source discovery, complete JUnit/timing partitions and downloaded archive
digests. `scripts/unit-shard-measurement.json` records that provenance; the
refresh names any observed unweighted file exceeding 30 seconds. Timings
are reviewed inputs, never fetched during contribution CI.

Runtime proof uses two independently selected jobs. `runtime` retains the three
loopback-only Claude probes and the shared-process Chrome/child-cleanup command;
`runtime_host` retains native managed hosted admission, including its four healthy
backend/UID cells, index-release negative control, owned loop cleanup, unchanged
runner quota and failure diagnostics. Both selections derive from the same runtime
requirement and both must pass the aggregate. Local `check:pr --full` and `--all`
retain the complete five-command inventory.

A single checkout cannot safely overlap those two long phases: both test wrappers
acquire its exclusive workspace-output lease, including the lease bind-mounted
into the native container. The Chrome fixtures rebuild output while retaining
that lease. The existing real-host/container lock controls prove contention;
read-only access rejects a nested build. Separate jobs preserve those ownership
rules without private-copy setup or an override. The exact two Chrome test files
still execute in one process with `--shard=1/1`. Native cell order, deadlines,
capabilities, offline namespaces and the pinned runtime remain unchanged.

The successful historical main run 38903809808 at
`626a03af4a9db064751230a84732755b8afa961e` records 702.725 seconds for the
serial runtime category: 13.522/9.719/4.571 seconds for the probes, 424.345 seconds
for hosted admission and 250.566 seconds for shared-process cleanup. Its four-CPU
VM sampled 2.540 GB used of 16.766 GB and 884.56 active CPU-seconds. These are
attributed historical observations, not a controlled current-source speedup.
The split's [runtime-only experiment 38920698136, attempt 1](https://github.com/schlessera/brain-kit/actions/runs/38920698136)
ran source `e7fea8b1ecb4a9f89f8651eca37e0bca797c20ad`, tree
`4c3f9f786a6838b02f43ae8753253c927956b2f8`. Actual checkout logs and
immutable checkout/resource artifacts agree. All five phases succeeded:
15.75 / 12.01 / 5.38 seconds for the probes, 265.72 seconds for shared-process
Chrome/cleanup and 427.17 seconds for separate hosted admission. Ordinary
runtime totaled 298.86 seconds (299-second proof step, 352-second whole job);
hosted admission took a 427-second step and 480-second whole job. The longest
whole job, including setup, satisfies the longest phase plus 90-second ceiling
(480 <= 517.17 seconds). This measurement workflow is an experiment, not a
production confirmation event.

[Automatic main run 38920963140, attempt 1](https://github.com/schlessera/brain-kit/actions/runs/38920963140)
independently executed merged source `80e028d84b7686d6cf864d8166029b1142de8756`,
tree `5f75530d5f191f6615f78736a7c67577b0cdbf84`, in both successful runtime
jobs. Its five phases succeeded in 11.90 / 8.85 / 3.93 / 194.25 / 424.80 seconds.
Ordinary runtime totaled 218.93 seconds; hosted admission's 425-second proof
step and 478-second whole job satisfy the same ceiling (478 <= 514.80 seconds).
The ordinary/hosted VM receipts record sampled peaks of 2.53 / 1.93 GB and
445.21 / 328.54 active CPU-seconds on separate 4-vCPU, 16.77-GB runners.
These source-bound main jobs establish phase coverage and the wall-time bound;
they do not establish a whole-workflow pass or a controlled speedup. The
experiment retains its own source and event identity. The separate
confirmation-event requirement remains tracked in
[#2128](https://github.com/schlessera/brain-kit/issues/2128).

A complete unit selection already includes cheap invariants, so CI does not run
that subset twice. No independent test/type job waits for packaging. The final
`proof` gate recomputes selection from the actual event and inputs, then examines every selected job: success is required; missing output,
failure, cancellation and unexpected skips cannot pass. Only explicit planner
exclusions permit skips. Exhaustive scheduled/manual runs detect selection drift
and remain supplementary to affected pre-merge proof.

Retain actual tested head/base/checkout identities, commands, attempts and
artifacts. Inspect new main commits before refreshing. The final candidate gate compares the actual merge checkout and immutable GitHub
commit/tree/parents to the requested head/base and live PR readiness/head plus
an independently queried base ref. A changed base requires a new confirmation
request, even when a reviewer considers that base change unrelated. This is a
conservative identity rule: no rebase is required solely to request a new
combined checkout, and admitted equivalent browser/layout domains can still be
retained. It supersedes the earlier permission to merge after only a manual
unrelated-base assessment. Endurance and Git-sensitive domains remain fresh. Reuse is justified only
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

Vitest's installed `list --filesOnly --json=<path>` discovers actual project/file
ownership without collecting suites. Browser and layout each fingerprint their
complete applicable static-import and validated indirect-input closure from
#2125, including CSS scan roots and assets. Unknown runtime/computed inputs,
unavailable discovery and invalid declarations require fresh execution.
Directory ownership includes added descendants; missing and symbolic inputs
remain conservative failures until fully supported.

Identical indirect expressions can name exact lexical function scopes; stale,
ambiguous or shadowed bindings remain unresolved. A narrow runner observation
class admits literal Linux boot identity, self status and self PID-namespace
queries through unshadowed imported filesystem readers. It rejects descriptor
paths, dynamic PID/path expressions, arbitrary files and non-reader constructs.
Those values are runner observations, never Git blobs or provider/repository
payloads. Other process/filesystem inputs still need supported ownership.

Generated fixture roots additionally require the root-redirect environment
variables `BRAIN_ROOT`, `BRAIN_WORKER_DATA_ROOT` and `BRAIN_WORKER_CONFIG_ROOT`
to be absent, including empty overrides. The versioned runner condition is
checked when making fresh receipts and revalidating current/source evidence.
A verified literal producer in an owned temporary root alone does not bind a
consumer reached through CLI arguments, cwd or configuration redirection.

A bounded command-activation audit covers seven dormant server, Mermaid and scene
callbacks. Registration in a selected project is allowed only when the complete
selected call inventory proves the callback is never invoked. It checks the
complete selected spec inventory, inherited setup/global hooks and their static
imports; actual invocation, callback escapes, dynamic loaders and aliased
command invocation retain fresh execution. Admission additionally requires exact
audited runner, configuration, callback and imported-helper source identities.
An edit requires a new audit rather than general TypeScript partial evaluation.
Only a proven inactive arrow body defers its runtime inputs. Its module and
static imports still execute and retain ordinary input checks, including any
top-level initializer or side effect. Dormant declared targets and their static
imports remain fingerprinted source bytes. This bounded support does not close
unrelated generated assets or provenance inputs.
The audited configuration, selected specs and inherited setup/global hooks are
also ordinary runtime closure roots; inspecting their command calls cannot
substitute for hashing their sources and resolving their executed input reads.

Generated consumer stylesheet imports bind the exact `ui-kit`/`ui-react`
`dist/styles.css` output and byte-copied theme/token exports to their source stylesheets, recursive CSS inputs and
tracked producer. The audited build cleans package output, uses the frozen
Tailwind dependency and completes successfully before browser execution and its
fresh receipt. Three audited command readers additionally bind the runner's
`packages/ui-kit` cwd. Producer, command or execution-path drift makes that
binding unavailable. Current `dist` bytes never substitute for source inputs.
Other generated artifacts, external assets and temporary readers remain unknown
until their own bindings are validated.

Two audited fixture readers consume the literal installed `axe-core/axe.min.js`
asset. Its explicit resource identity records package name/version, relative
asset name, SHA-256 and mode in addition to the matching manifest/lockfile and
frozen-install conditions. Missing, symbolic, escaped or changed reader inputs
remain fresh. This is exact-file validation, not a scan of `node_modules` or a
claim that arbitrary installed files belong to a domain.

Two exact source-owned literal payloads—the rectangle SVG fixture and the
black/white pixel probe—have no resource loads or executable content. Their
complete owner and call identities validate the actual Playwright sink and
lexical binding. Interpolated HTML and other payloads remain unresolved; this
support cannot certify arbitrary generated documents.

The complete activation-audited import inventory also seals two bounded reader
flows. The exact browser sequencer calls the cost reader without an override,
so its default is the module-relative cost JSON. The exact font command fixes
the repository and lock-hash cache roots, verifies every length/checksum before
use and replaces the pinned stylesheet URLs with those verified bytes. Reader,
caller and font JSON/CSS/head identities must match their audit; additional
imports, reexports or loaders into either reader require fresh execution. These
bindings name only the exact consumed repository bytes. They do not bless
arbitrary file parameters, changed font data or unverified cached content.

Two finite private dispatch registries admit their exact indexed calls while
every handler and imported helper retains normal runtime input traversal. The
source audit verifies literal function entries, copied handler maps and private
non-escaping registries. The complete importer inventory rejects additional
map consumers; two exact consumers of a different chat helper are separately
audited. Changed source, escaping maps or new consumers require fresh execution.

The dictation theme command has a separate temporary-output producer binding.
Its exact source owns a new temporary directory, invokes the locked Tailwind
CLI with constant input/output arguments, awaits successful completion, reads
only that output and removes the directory. The binding includes the compiler
asset identity, checked build producer and recursively resolved CSS entry,
theme, tokens and explicit source scan. Its precise `promisify` and
`createRequire` uses do not permit other aliases. The runner registration and
complete importer inventory seal the command's caller; source or input drift
requires a new audit. This support does not admit arbitrary subprocess outputs.

One interpolated HTML fixture is separately bound to its exact producer and
complete selected command-call inventory. The destination-press spec supplies
only the source-owned paragraph document plus an explicit reporting/scroll
script; its other call removes the route. Exact configuration, command owner
and caller bytes seal the argument origins. Additional direct, renamed or
await-import command callers, escaping command aliases or direct owner imports
require fresh execution. This is a producer binding, not an assertion that
HTML containing a script is inert.

The argument-free ghost replay has a distinct self-contained-document binding.
Its sole exact caller first renders the literal Performance story, then copies
that scene's DOM and the loaded CSS rules. The preview, inherited font setup,
checksum-verifying font producer, lock/CSS/head inputs and replay guard are
source-audited; all imported component and CSS dependencies retain their normal
closure traversal. Verified font bytes are inline data URLs. The replay page
aborts and records every HTTP/websocket attempt, also records request events
that could bypass routing, and asserts no attempts after document/font loading
and before/after tracing. Loopback resources receive no exemption. A resource
attempt fails the actual proof; source, caller, guard or producer drift requires
a new audit. The scene, visual assertions and trace remain unchanged.

Diagram capture binds both exact callers and their complete call-site inventories,
closed SVG primitive producers,
literal adopted fixture, generated consumer CSS and locked inline-font inputs.
Its additional replay page contains that source-owned document, aborts and records
HTTP/websocket requests, and checks the zero-request invariant after document and
font loading and after capture. Unknown DOM or resource origins remain unresolved;
source or producer drift requires fresh execution and a new audit.

The selected browser capability additionally requires a complete audited
input-domain identity and an enforced zero-Worker boundary. The native,
forwarding diagnostic established no intended Worker execution in that
selection; its observation ended at `afterAll`, so it does not claim returned
cleanup coverage. Enforcement installs before product imports, records and
refuses every construction attempt, checks after test hooks and checks again
in the earliest outer `aroundAll` finally after returned/file-fixture cleanup.
Catching a construction error in the product cannot make its proof pass. The
original descriptor is restored completely after checking. Real PDF-worker
runtime categories and the layout/endurance projects retain fresh unrestricted
execution; no product constructor or configuration default changes.

Admission validates exact known enforcement/configuration sources independently
of the audit manifest, then joins every selected source/data path, blob/mode,
directory membership, resource identity and inventory entry to that bounded
audit. Any relevant source, caller, realm, hook, guard or data edit executes
fresh until re-audited. A constructor hidden by a new alias cannot bypass this
mandatory browser capability check merely by disappearing from syntax
discovery. Unknown external resources still prevent admission. The manifest's
own bytes are ordinary shared fingerprint inputs; it is never self-hashed.
Version 2 separates current source-audit admission from historical diagnostic
observations. Historical case counts and their cleanup gap remain attributed to
the old selection; adding projects does not fabricate a whole-domain observation.
Old or missing admission metadata stays fresh. Its metadata cannot replace
complete successful guarded fresh jobs or the
independent retained-proof validator. This bounds the existing PDF constructor
to no consumed Worker resource; it does not authorize an arbitrary worker URL.

Vitest screenshot references are inputs too. The pinned installed resolver's
verified defaults locate them under each selected spec's own
`__screenshots__/<spec basename>` directory. Eligible immutable tracked paths,
bytes and modes join the closure and capability identity, including added,
deleted and renamed baselines. A tracked file/symlink at a baseline directory
cannot hide an external reference. Custom screenshot directories/resolvers,
matcher aliases and unresolved option objects stay fresh; only closed literal
comparison settings are supported. The framework asset identity joins the
locked installed resources. No current output or untracked image enters this
snapshot, and baseline changes cannot inherit old passing comparisons.

The inclusion fingerprint binds relevant immutable Git paths, blob identities
and modes, selected discovery ownership/order, the two measured partitions and
runner identity. It also includes every proof/tooling script and workflow,
root/package manifests and lockfiles, compiler configuration and expanded build
source inventories. These conservative shared harness inputs can invalidate
retention even when only one domain executes them. Unrelated prose is not an
input merely because it is tracked; imported or declared prose remains included.

Source/current closure discovery uses separate raw-Git-blob snapshots. Workspace
package links resolve inside their own snapshot, while external dependency
resolution uses the frozen install only after source/current algorithm,
configuration, manifests and lockfiles match. Current generated/dist artifacts,
working-tree bytes and Git archive substitutions cannot stand in for immutable
source content. A helper or dependency identity mismatch executes fresh.

The implemented fingerprint is only a necessary condition for retention. A
bounded browser admission still needs the complete guarded fresh baseline and
real retained-proof validation; unsupported layout/runtime inputs continue
fresh execution. Neither a synthetic closed fixture nor a graph
structure hash establishes a real hosted retention hit. #2126 remains open until
its controlled same-PR hosted demonstration and independent aggregate evidence
are complete.

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
The escaped ledger output stays below 90 KB, leaving room for the aggregate's
other outputs under the native per-environment-string limit; larger receipts
execute fresh.
Record actual retained runner time and lookup/aggregate costs on a controlled
base advancement. This preserves runner consumption without claiming that
unchanged browser proof removes a remaining long native critical path.
Discovery has a 15-second timeout; a missing immutable Git object has an
eight-second bounded fetch. Runner image context comes from the image's
[recorded environment](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-environment.sh).

### Execution domains and assertion ownership

The [proof-domain inventory](../process/proof-domains.md) describes default
ownership and the recording split. `bun run test:inventory` uses actual Vitest
file discovery and Bun default discovery, emits declaration/assertion source
locations, refuses missing/duplicate browser ownership and misplaced endurance
files, and reports unmeasured browser weights. Source locations are navigation,
not an expansion of dynamic cases or a substitute for executing assertions.
New ordinary tests conservatively join complete final discovery. There is no
duration threshold that silently removes expensive cases. Keep paid opt-in
provider tests and experiment-only discovery distinct.

`bun run test:endurance` selects `ui-react-endurance` and every `.endurance.tsx`
file, with the same pinned image, offline Docker network, real media APIs,
deadlines and cleanup. Mixed files retain their short functional/security cases
in ordinary proof. The separate job has one project and the original sequential
file bound; it runs on its own VM alongside ordinary proof, never adds browser
contention within a layout shard, and contributes no ordinary shard weights.
Full local preflight remains sequential for safe resource ownership; standalone
endurance can run concurrently in a separate checkout. Hosted confirmation,
main affected proof and exhaustive scheduled/manual runs require endurance
whenever UI/global inputs select it. Missing/cancelled/skipped selected endurance
is a failed gate, not deferred optional coverage.

## Measuring the critical path

Record queue wait, setup/install/build and suite times, job elapsed times, ready-to-merge duration, cancelled attempt
time and repeated work after base advancement. Historical Depot samples (198
terminal workflows, 43% cancellation consumption, median successful 21-minute
elapsed/93-minute summed time) explain the former policy; they are not hosted
GitHub benchmarks. Measure the new pinned runner before changing shard counts,
browser file concurrency or test deadlines. Free runner minutes do not remove
account concurrency limits. Preserve diagnostic reports and failure images,
with bounded artifact retention. Each proof job emits per-command elapsed times
and VM-wide active CPU seconds and sampled used memory (including container
work) to `proof-resources.json`. These one-second samples are not an exact
process peak; job-step timestamps supply setup and queue costs. Keep source,
runner identity and resource scope beside comparisons, and never infer causal
speedups from unrelated historical SHAs. Fix flaky behavior; never rerun a real failure
or shorten its assertion merely to obtain green.

The repository is user-owned, so native GitHub merge queues are unavailable.
Do not invent a queue or require ownership migration as part of this change.
Matching-head merges still require a live base/head read immediately before
merge and actual squash parent/tree verification afterward. A passing check
cannot lock the base against another merge. If it changed since confirmation,
request confirmation again; if it races the merge, do not attribute old proof
to the new tree. The workflow is a fail-closed evidence gate, not a repository
permission: without branch protection a writer can technically bypass it.
Agents must not do so, and this policy does not change protection settings.
The read-only [Get a pull request API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
accepts the existing `contents: read` permission; no privileged token/event is added.

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

### Independent Bun test-only changes

A PR changing only unreferenced Bun test files and prose selects those
files plus their owning fast invariant groups. Other tracked files must not
name a test basename, the files must export nothing, and expanded package build
inventories must not consume them. Source and shared helper inputs are unchanged,
so executing the changed leaves covers their changed results without repeating
reverse dependants or unrelated browser, layout, endurance and capture domains.
A named runtime command retains ordinary runtime selection through the reference
fallback. Fixtures (including Markdown), helpers, snapshots, exported/referenced
or deleted tests, unknown inputs and unavailable scans retain ordinary selection.
Main pushes and exhaustive runs retain complete affected/default discovery.

The exact unit inventory is validated against default Bun discovery. It includes
owning fast tests once, and uses at most the existing four partitions, reduced
only when fewer files exist; no empty partition or duplicate execution substitutes
for coverage. Selected categories remain required by the unchanged aggregate.
