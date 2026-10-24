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
Import-graph feedback is opt-in with `--import-graph` under the maintainer's
2026-10-23 ruling in [#2707](https://github.com/schlessera/brain-kit/issues/2707).
On a #1665 layer, the serial feedback command ran 308 of 1170 files in 2873 s,
versus 84 s for affected fast invariants, accounting for approximately 95% of
local preflight time. Default preflight skips that command; `--plan` reports
the skip and enabling flag and lists the selected commands and arguments,
including contribution changeset validation. Opt-in feedback retains the exact
merge-base SHA, offline wrapper and `--pass-with-no-tests`; its import graph
misses spawned and file-read/string-named inputs. Restoring default execution
requires the separately qualified follow-up through `scripts/unit-workers.ts`.
Full/all modes and required hosted proof retain their existing suites.
It does not require Docker or Chrome and does not duplicate complete packaging,
strict types or full browser/runtime proof. Under the revised #2370 scope, Linux
preflight requires permitted user/network namespaces and times three real
sandbox setups before checks run; the fastest must take less than 1000 ms
(raised from 250 ms by maintainer ruling on 2026-10-21, so local preflight
runs on hosts with a moderate bind-mount backlog; slower setup still refuses).
A probe timeout retains its 5 s budget and refuses with an elapsed lower bound
and actionable host diagnostics, separately from an ordinary failed setup.
The timing probe belongs to the local CLI entry point. Hosted categories use
their own runtime prerequisites: container-backed browser/editorial proof does
not require bubblewrap on the host, while native proof retains its namespace
prerequisite. This leaves product and test deadlines unchanged. Agents still supply
focused failing-first and restored mutation receipts, debug failures and review
visual results. A test failure is not excused by moving its execution.

Under the [2026-10-22 Option A ruling for #2401](https://github.com/schlessera/brain-kit/issues/2401#issuecomment-6329614279),
deliberate manual offline commands use `scripts/test-offline.sh`: verified fresh
user/network namespaces, loopback plus a route-free dummy, empty IPv4/IPv6 main
tables and verified zero capabilities before the command. This preserves the
real browser online signal and upload policy while denying external networking.
Optional mount isolation composes with caller-provisioned fixture storage;
the [testing guidance](../process/testing.md#deliberate-offline-commands-on-linux)
documents prerequisites and the `--keep-caps`/bubblewrap trap. Generic test,
hosted-worker and existing preflight-probe launch paths are unchanged.

CI supplies authoritative complete repeatable proof on explicit ready-candidate requests. Complete
unit/integration discovery normally includes affected workspaces and every reverse
manifest dependant, plus root tooling tests. Under the maintainer's
[2026-10-20 option B ruling](https://github.com/schlessera/brain-kit/issues/2404#issuecomment-6286701867),
package changes additionally select runnable unit consumers of the actual changed
import targets. Package exports use the Bun source condition; relative imports,
re-exports, shared helpers, cycles and statically named spawned fixtures contribute
transitively. A direct import of `src/types.ts` does not imply an import of an
unrelated `src/index.ts`. Manifest dependencies are the coverage floor, not an
exhaustive inventory of test inputs.
Importer and target package scopes are resolution inputs too: changing an export,
entrypoint or package import map can select a consumer without changing either
source file. The graph retains those manifest paths, including absent nested
scopes whose addition or deletion can change resolution.

Computed, unresolved, unreadable and unsupported import edges conservatively add
their reachable runnable unit owners even when those owners are outside that
floor. Failure to construct a trustworthy graph expands to complete unit discovery.
An explicit unit inventory contains the entire previous manifest/root inventory,
these additional consumers and selected fast tests exactly once; it never replaces
the floor with only import matches. Static resolution does not execute source,
configuration or arbitrary loader expressions. Unknown runtime loaders can
therefore select many consumers; that widening is a correctness cost, not a
speedup or a reason to ignore them. Runtime access to the `node:module`/`module`
loader API (including namespace/default imports, re-exports and aliases), and
unsupported loader object/resolver aliases, retain their runnable owners.
The implementation keeps discovery, reverse ownership and floor-preserving
composition separate (`discoverUnitImports`, `scripts/unit-test-consumers.ts:31-187`;
`unitImportOwners`, `scripts/unit-test-consumers.ts:190-196`;
`addUnitImportConsumers`, `scripts/unit-test-consumers.ts:206-225`).

The whole-class audit independently resolves current cross-workspace test sources,
then traces their runnable owners, including extension-appending launch helpers
and file references. An undiscovered helper is not automatically native-only.
Browser/layout/native entrypoints retain their existing runners and selectors;
they never become Bun unit files or count as passing unit coverage. Unresolved
ownership fails the audit, and independent category gaps must be reported.
The independent test-only exception below, existing category selection,
discovery refusals and complete shard-union validation remain unchanged.

Global/unknown inputs expand to complete
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

### Isolated local import-graph feedback

Local import-graph feedback uses eight workers on the measured 32-CPU,
47-GiB host. The default is
`max(1, min(floor(cores / 4), floor(RAM * 0.7 / 2 GiB)))`, with
`--import-graph-workers=N` as the override (`localUnitWorkerCount`,
`scripts/unit-workers.ts:15-17`). Changed-mode workers use one fresh prepared
build and private overlay views; `unit-workers --private-tree` retains the
ordinary private-build comparison. Hosted explicit-file partitions retain
`balanceTests`, their private builds and N=2.

Feedback remains **opt-in** with `--import-graph`: the prepared N=8 result was
25m 38s, above the 900-second gate for restoring default feedback. N=8 passed
both queued observations, one with private builds and one with a prepared tree.
These are different preparation modes, not two identical prepared replays.
The maintainer requested trends and general figures and stopped full repeats
for a one-file selection change; no additional full replay is claimed.

The sweep ran on Bun 1.4.2 after merging #2728's main repair
`9f930f6e335dca6f3be49ce35e378d11d7734c37`. The serial/private source was
`1610c84de5f1804c2c6411bb030e2ce2f8b4e2d6`, compared with merge-base
`f321d986cc6dcf522885a5e7cf3d4c8f0cf3f162`. Serial, N=4 and N=8 passed
exactly 464 files / 5,915 cases / four skips. The prepared source was
`a529ebd288c1b806f347fb4e51638385327fd6a6`; its package tree, lockfile,
manifest and dependencies were unchanged. Its changed invocation harness
selects one additional existing file, `haiku-model-runtime.test.ts`, and adds
one tooling case: prepared N=8 passed 465 files / 5,917 cases / four skips.
Its inventory contains every earlier serial file plus that one addition.

| Preparation | Workers | Wall until exit | Minimum available RAM | Host CPU | Start load (1/5/15m) | Other check:pr range | Result |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| Serial | 1 | 58m 30s | 31.1 GiB | 9.8% | 4.61/3.88/3.93 | 0 at start | Pass |
| Private | 4 | 34m 29s | 32.6 GiB | 12.6% | 4.96/5.29/5.85 | 0–1 | Pass |
| Private | 8 | 26m 29s | 29.6 GiB | 21.5% | 4.87/5.12/5.94 | 0–3 | Pass |
| Private | 16 | 21m 51s | 21.4 GiB | 30.7% | 8.29/8.22/9.15 | 0–2 | Known #2701 failure; incomplete |
| Prepared | 8 | 25m 38s | 32.5 GiB | 13.7% | 4.01/5.45/6.84 | 0–2 | Pass |
| Prepared | 16 | 9m 01s | 34.3 GiB | 25.1% | 3.90/5.15/5.95 | 0–2 | #2737 plus exempt #2701; siblings cancelled |

The N=16 failed durations are time until failure and cleanup, not successful
completion times. No timeouts were observed. Private N=16 failed
`host-fallback-folder-policy.test.ts`, “launch (descendant yes, replaces
group/private, owner crash): a folder policy refuses the old host before a
governed worker pins the folder”, with `invalid worker mount record`.
Prepared N=16 hit that same exempt [#2701 class](https://github.com/schlessera/brain-kit/issues/2701#issuecomment-6373158682)
in `governed-worker.test.ts`, “the live launch qualifies mounted folders before
preserving their ordinary writes”. Its non-exempt failure was
`egress-proxy.test.ts`, “CONNECT opaque bytes require outward approval and retain
bidirectional accounting”: the completion record was absent after a fixed 1ms
wait ([#2737](https://github.com/schlessera/brain-kit/issues/2737)). That prevents
choosing N=16 from this sweep. No guard, assertion or deadline was weakened.

| Preparation / N | Common checkout / copy / build | Worker checkout / copy / maximum build or adoption | Longest test shard |
| --- | ---: | ---: | ---: |
| Serial | — | 0 / 0 / 50.3 s | 3459.4 s |
| Private / 4 | — | 2.7 / 12.2 / 86.0 s | 1962.0 s |
| Private / 8 | — | 5.0 / 25.9 / 126.0 s | 1423.1 s |
| Private / 16 | — | 12.1 / 36.2 / 217.8 s | 1022.0 s until cancellation |
| Prepared / 8 | 0.8 / 6.9 / 75.9 s | 9.4 / 0 / 0.1 s | 1439.7 s |
| Prepared / 16 | 0.8 / 9.0 / 63.2 s | 18.2 / 0 / 0.2 s | 439.3 s until cancellation |

Checkout and dependency-copy columns are queue phase durations; build/adoption
is the maximum per worker. The linked evidence records each worker separately.
Private N=16 setup accounted for 266s, 20% of its attempted wall time, triggering
the prepared-tree variant. Prepared setup was about 93s at N=8 and 91s at N=16.
At N=8 the observed wall gain was only 51s: test imbalance remains the long tail.
The same 16 Chrome runtime files took 1362 / 1503 / 1735 / 2007 seconds in summed
file time for serial / private N=4 / N=8 / N=16. Parallel sessions rose from
425s serially to 455 / 535 / 596s. Higher concurrency does slow individual suites.

The timing seed was unchanged. N=4 assigned 150 / 6 / 6 / 302 files; known seed
costs summed to 892 / 866 / 850 / 748s, while completed file times were
679 / 550 / 584 / 1963s. The final shard held 75 unweighted files. A separate
[qualified timing refresh](https://github.com/schlessera/brain-kit/issues/2736)
tracks the stale costs; local observations were not pasted into the reviewed
hosted table.

Memory is whole-host minimum `MemAvailable`; CPU is whole-host busy time,
including concurrent work. One-second independent process sampling excludes
benchmark descendants, including tooling fixtures. Serial independent sampling
covers its last 643 seconds, all with zero other check:pr processes. N=8 private
execution overlapped other check:pr processes for 398 samples. Brief prototype
checks also ran during private N=4/N=8. Runs were sequential and shared the host;
these are trends, not a randomized speedup estimate. Full uptime, per-worker
phases, inventories, hashes and historical receipts live in
[the sanitized evidence](../process/evidence/local-import-graph-2708.json).
The earlier 439-file comparison stopped on the separately repaired #2721;
it remains historical evidence, not a new queue flake.

The [option-2 ruling](https://github.com/schlessera/brain-kit/issues/2708#issuecomment-6366282293)
keeps Bun authoritative. A real twelve-file fixture proves `--changed` selects
five files before weighted `--shard` assigns 1 / 1 / 3 of them. Every worker
runs `bun run test --changed=<merge-base> --shard=i/N` with the committed seconds
converted to Bun timing milliseconds. Workers observe Bun's selected/assigned
counts and reconcile JUnit with completed timing paths. Missing or duplicate
files or shards fail (`changedSelection`, `scripts/changed-unit-worker.ts:5-16`;
`validateChangedUnitReports`, `scripts/unit-proof-report.ts:38-57`). Empty shards
need successful zero-file receipts. Committed history, staged/unstaged binary
patches and untracked inputs retain Bun's working-tree semantics; verified
cleanup reverses only captured inputs (`captureUnitInputs`,
`scripts/unit-worker-inputs.ts:33-74`).

The prepared owner holds one fresh build descriptor and lease until its private
overlay views finish. Each view has its own Git index, upper/work directories,
write lease, nonce and output generation. The lower tree is read-only and uses
`userxattr`, allowing nested builds to remove/recreate lower directories in the
private upper layer. The reference filesystem refused reflinks; overlayfs works
in unprivileged user/mount namespaces. Ordinary private copies retain
`cp --reflink=auto` fallback.

Workers drop capabilities. An offline Unix-socket client verifies the live
owner's peer PID, receipt digest and registered destination across namespaces;
each view publishes its own `workspace-build-copy` authority. Ordinary nested
wrappers still build afresh, and later writers revoke copied authority
(`preparedSourceBuild`, `scripts/test-invocation.ts:129-149`;
`prepareCopiedInvocation`, `scripts/test-invocation.ts:178-191`). There is no
cross-run build reuse. Offline preload, per-test deadlines, maintenance ledger
and diagnostics collection remain intact. Diagnostics are copied while views
are mounted; failed cleanup retains dirty upper layers and the prepared source.
Private reports stay outside the public tree. Invocation identifiers prevent a
reused report destination from supplying stale cleanup receipts.

#### Reviewed timing refresh

The #2736 refresh uses
[exhaustive hosted run 39998539459, attempt 1](https://github.com/schlessera/brain-kit/actions/runs/39998539459/attempts/1),
source `48364d94f8014357ab72ffa28ce0f7e7c6a78baf`, tree
`5009f1252d894615a094b8ad0bcd6eacf05235f9`. The existing explicit command
verified all four successful unit jobs, their completed-file/JUnit inventories,
checkout logs, immutable source discovery and downloaded archive digests.
`scripts/unit-shard-measurement.json` records each job and artifact identity.
The table grows from 955 to 1,180 positive weights, adding 225 files without
removing any earlier path. The four hosted partition estimates on that source
are 1088.413 / 1088.512 / 1088.512 / 1088.413 seconds; these are estimates for
new assignments, not remeasured job durations.

New observations above 30 seconds include `worker-var-sockets` (90.999s),
`egress-first-party-paths` (122.874s), `test-invocation` (50.967s) and
`unit-test-consumers` (44.858s). The reviewed weights for
`http-supported-mounts` and `governance-policy` rise from 25.142 / 2.889 seconds
to 36.549 / 4.753 seconds. Large runtime reductions also belong to their
completed-file observations; the refreshed hosted source already uses one
build per invocation. Local wall times describe different hardware, source and
load, and never replace those hosted values.

Of the original 82 unweighted wide-selection files, 81 now have hosted weights.
`tests/changed-unit-workers.test.ts` was added after the qualified hosted source
and retains Bun's ordinary unseeded behavior; the earlier serial observation
was 9.242 seconds. Complete coverage means the qualified source's entire
1,180-file discovery, rather than a promise to seed later additions.

The [refresh procedure](../process/ci-timings.md#refresh-reviewed-unit-weights)
retains all attribution controls. For example, the newer successful main run
40026244740 attempt 2 was refused because repeated unit uploads left duplicate
artifact names; run 40024930605 was refused as nonexhaustive. Neither supplies a
weight in this table.

The single refreshed N=8 prepared-tree replay used source
`a529ebd288c1b806f347fb4e51638385327fd6a6` and base
`f321d986cc6dcf522885a5e7cf3d4c8f0cf3f162`, changing only the table and its
receipt. Bun selected 469 files: all 464 original serial files, the previously
recorded extra `haiku-model-runtime` file, and four tooling files affected by
the seed-table edit. An independent name-filtered serial collection confirmed
that exact 469-file selection; all 6,017 cases were filtered, so it is an
inventory inspection with exit 1, not passing behavioral proof.

| Worker | Before files | Before known seed / completed seconds | After assigned files | After known seed / reported seconds | After outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 146 | 457.258 / 504.853 | 97 | 342.236 / 372.476 | Pass, four existing skips |
| 2 | 4 | 434.991 / 257.137 | 53 | 392.595 / 436.656 | Pass |
| 3 | 3 | 616.299 / 526.599 | 3 | 420.396 / 500.974 | Cancelled; browser-close errors |
| 4 | 5 | 415.309 / 90.955 | 7 | Unavailable | Cancelled; no JUnit |
| 5 | 2 | 497.009 / 587.738 | 65 | 281.932 / 499.886 | Failed rollback-writer readiness |
| 6 | 4 | 344.048 / 181.539 | 51 | Unavailable | Cancelled; no JUnit |
| 7 | 112 | 372.275 / 1272.314 | 83 | Unavailable | Cancelled; no JUnit |
| 8 | 189 | 283.692 / 1440.440 | 110 | Unavailable | Cancelled; no JUnit |

The earlier 25m 38s observation passed. The refreshed arm stopped after
**599.166 seconds (9m 59s)** at failure and cleanup; it has no successful
completion duration. Common checkout/copy/build took 1.384 / 2.734 / 78.307
seconds, worker checkout 9.768 seconds and maximum build adoption 0.105 seconds.
Only 218 unique files have JUnit-backed reports, including 150 in successful
workers, so the final report union does **not** equal the 469-file serial
selection. Cancelled workers' 1,180-entry seed files are not completed timing
observations and are excluded from the table above.

The rollback writer missed its 5-second readiness signal; a focused unchanged
invocation reproduced the same failure. It is tracked as
[#2747](https://github.com/schlessera/brain-kit/issues/2747), outside this
weight refresh. Worker 5's exit cancelled five siblings, including the browser
errors. No guard or deadline was changed and no additional wide replay ran.
An initial private-build setup was explicitly cancelled before cases ran,
after detecting that the frozen source requires `--prepared-tree`; it supplies
no performance result.

The host began at load 31.01 / 26.83 / 14.96 and ended at
13.18 / 17.27 / 15.50. Whole-host minimum available RAM was 30.341 GiB,
CPU busy time 23.800% (7.616 average busy cores), and child CPU 1281.445 seconds.
One-second samples observed 0–1 other check:pr processes, 8–20 test wrappers,
0–2 builds and 0–3 native hosted proofs; nested wrappers and this task's separate
inventory build are included, so these are process counts, not independent run
counts. Source-bound per-worker observations, inventories, load and limitations
are in [the sanitized refresh evidence](../process/evidence/unit-weight-refresh-2736.json).

**Default feedback stays opt-in.** The failed 599-second duration cannot qualify
a setting at or below 900 seconds. The incomplete after-balance, different
load and four added tooling selections support no successful speedup claim.

#### Rollback-writer readiness and the subsequent wide recheck

The #2747 fixture diagnosis reproduced the original five-second readiness
failure under CPU pressure. A traced child spent 5.775 seconds in its
uncommitted 300-row update, including 299 `fsync` calls taking 5.544 seconds.
SQLite's [cache-spill sequence](https://www.sqlite.org/atomiccommit.html)
flushes the journal before spilling dirty pages. Bun startup was a smaller
part of the separately measured child phases.

The fixture now commits its 300 padded seed rows before the bounded readiness
window, then updates sixteen rows in the child with the existing five-page
cache. Readiness still follows the update. The test asserts SIGKILL, a hot
journal header and changed database bytes before its original copy, committed
row recovery, integrity and writeability checks. The five-second readiness
limit, per-test deadline, product preparer, isolation and offline guards are
unchanged (`killRollbackWriter`,
`packages/ui-sdk/tests/maintenance-index-input.test.ts:16-37`). Removing the
journal before recovery fails the original row-sum assertion, and thirty
sequential repetitions pass under both twenty and forty busy loops on four
CPUs.

The one subsequent eight-worker `check:pr --import-graph` ran at fixture commit
`ada2e1767626ef6f4e8fa7ef50784998988eaa5c` against reference base
`f321d986cc6dcf522885a5e7cf3d4c8f0cf3f162`. Current source selects 626 files,
containing all 464 historical reference files plus 162 additions. All eight
JUnit/timing inventories reconcile exactly once, with 7,970 passing cases,
four skips and two failures. The rollback-journal case passes in 517.28 ms.
Both failures are exact-note assertions in `worker-sandbox-note.test.ts`:
ambient provider-variable names appear in pi's note while the fixture expects
an empty provider list. An empty-environment control passes all three focused
cases; fictional provider values reproduce both failures. The independent
fixture repair is [#2769](https://github.com/schlessera/brain-kit/issues/2769).

Complete preflight wall time is 1289.718 seconds (21m 29.7s); queue wall time
is 1203.034 seconds. This is a failed attempt, not a successful qualification.
**Feedback remains opt-in.** Minimum available RAM is 30.437 GiB and whole-host
CPU is 18.535%; concurrent proof and focused pressure diagnostics overlap the
run, so these are shared-host observations rather than a controlled speedup.
The [source-bound receipt](../process/evidence/rollback-writer-readiness-2747.json)
records phase timings, per-worker reports, reference coverage, load and limits.
The earlier failed #2736 receipt remains unchanged; local observations never
replace the reviewed hosted timing weights.

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
A draft run's aggregate is named `draft gates`, never `proof`, so its cheap
success cannot stand as a ready PR's proof. GitHub can queue a draft push's run
after the `ready_for_review` run and cancel it, leaving no `proof` at all. The
draft aggregate also reads the live PR and fails when that read finds it ready,
closed or at another head, which turns the cancelled request into a visible
failure; a transition after the read is still covered by the distinct name
([#2363](https://github.com/schlessera/brain-kit/issues/2363)).
Main pushes still execute complete affected proof. Scheduled and manual runs
execute exhaustive discovery with a distinct aggregate check name, so they
cannot impersonate a PR's candidate confirmation. Title/label edits run the separate contract gate, not long
proof. Main commits keep independent SHA concurrency groups; obsolete heads of
one PR share a cancellable group. Different PRs never cancel one another.

After cheap gates, packaging, strict verification, unit shards, runtime probes,
browser shards, layout shards, a separate endurance job and captures start independently.
There are four measured-cost unit partitions, three browser and two layout partitions
(`PROOF_SHARDS`, `scripts/proof-shards.ts`, which the workflow guard matches against the matrices),
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
the observation record.

> **2026-10-22 — Budget separation.** The 30-minute unit allowance is now an
> explicit proof-step limit. [Separate setup capacity](#separate-environment-setup-and-proof-budgets)
> raises the combined job cap to 45 minutes without changing proof deadlines.

Browser sharding uses the committed per-project/
file table under #1082, rather than grouping every pointer variant of a costly
file in one hash/count bucket. Unknown specs retain positive defaults, every
spec is assigned once, and unsharded discovery is unchanged. Refresh explicitly
with `bun scripts/refresh-browser-costs.ts <run-id> <attempt> [browser|layout]`
(the default remains browser). Each domain retains its own run/attempt/job,
checkout/tree/parent and pinned-image provenance. Refresh requires fresh
successful jobs from every shard of a successful CI run, matching actual checkouts, complete
reported project/file coverage and source/image attribution; cancelled,
partial or retained-only proof supplies no measurements. Refreshing one domain
preserves the other's costs and provenance. Reviewed CI reports are measurement
inputs, never runtime dependencies. Layout refresh admits ordinary
`ui-react-layout` measurements; `ui-react-endurance` remains a separate mandatory
fresh job and never becomes an ordinary browser/layout weight. Requalify timing
inputs after scenario ownership changes: the former combined recording-file
measurement includes endurance and is not its current ordinary-layout cost.
Layout keeps two shards; per-project serial execution and all test deadlines remain unchanged.
Browser proof runs in three shards and its jobs have a 20-minute bound. It was raised from 15 minutes after browser
(2) reached 887 s on main and 917 s on a ready PR ([#2414](https://github.com/schlessera/brain-kit/issues/2414)). A weight refresh still
qualifies by measured whole-job elapsed time, not by the bound.

### Separate environment setup and proof budgets

The maintainer's [#2658 ruling](https://github.com/schlessera/brain-kit/issues/2658#issuecomment-6342812579)
separates network prerequisites from proof capacity. In successful main run
[39784542134](https://github.com/schlessera/brain-kit/actions/runs/39784542134),
`runtime_host` setup took 68 seconds and proof took 676 seconds (11 min 16 s).
Run [39785773042](https://github.com/schlessera/brain-kit/actions/runs/39785773042)
reported setup durations of 8 min 52 s and 6 min 32 s; the latter included
6 min 3 s fetching 33.6 MB from the Ubuntu mirror during the native image
build. Both attempts exhausted the shared 15-minute job cap while proof was
still progressing. The supplied raw and step-labelled slow-log exports both
describe the 6 min 32 s attempt; they are not independent measurements.

Every workflow call to `ci-runtime-setup.sh` now has a 12-minute step limit.
This leaves 3 min 8 s above the longest reported setup, bounding mirror stalls
without spending the proof allowance. The proof steps explicitly retain the
former job ceilings: 15 minutes for `runtime` and `runtime_host`, and 30 minutes
for each `unit` partition under #1485. Job limits are the sum of setup and
proof plus three minutes for checkout, dependency install, planning, tracing,
summaries and artifact upload: 30 minutes for either runtime job and 45 minutes
for unit. In the supplied successful and slow logs, checkout/install/planning
plus trace startup took less than 30 seconds, so this reserve has margin;
it is finite, not a guarantee against arbitrarily stalled unrelated steps.

The shared-script audit includes unit's network package installation. Browser,
layout, captures and endurance do not call this setup script; their pinned
container setup remains inside their existing proof jobs and keeps its bounds.
The [step timeout](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepstimeout-minutes)
terminates setup independently; default failure handling skips proof when a
prerequisite fails. An `always()` summary prints separate setup and proof
outcomes and limits, identifying setup as an infrastructure prerequisite. Setup
timeout/failure with skipped proof therefore differs from successful setup
followed by proof failure/cancellation. Workflow lint guards the setup limit,
unchanged proof limits and combined job capacity. All native assertions,
per-command deadlines, selection gates, runtime/action pins, offline images
and diagnostic uploads retain their existing behavior.

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

### One fresh build per test invocation

The [2026-10-20 option-B ruling for #2279](https://github.com/schlessera/brain-kit/issues/2279#issuecomment-6293488248)
permits one fresh package build under the invocation's continuously held write
lease. `scripts/test.ts` prepares the selected runtime consumers' forward
package closure before starting Bun tests. Each private unit worker requests a
full build inside that same build/test lifetime, after namespace entry. There
are still at most two workers, with serial compilers inside each. A worker can
now start tests while its sibling is still preparing; account for this scheduling
placement separately from duplicate compilation avoided.

The seventeen runtime hooks use a checked helper. Admission requires the live
ancestor coordinator's PID/start identity, invocation nonce, canonical checkout
and root inode, active exclusive lease owner/descriptor/inode, and the actual
builder's completed successful package/child receipt for the required closure.
The coordinator waits for exit and both output EOFs before publishing a bounded
record through its held descriptor. Closing the descriptor or losing the owner
revokes it; leftover files and the builder's best-effort observation fingerprints
have no authority. Failed or signaled preparation stops the invocation before
tests; missing diagnostics after successful preparation leave hooks rebuilding.

Build and test commands each run beneath a private process-group anchor that
stays alive until command exit and both output EOFs have been joined. Cancellation
signals only that anchored group, with one-second forced cleanup for survivors
and children forked during signal handling. Losing the wrapper's IPC lifetime
channel also stops the group. A command leader exiting first cannot orphan its
inherited-output holders, and a nested wrapper does not signal the outer lease
or unrelated siblings. The anchor closes its own output descriptors after launch
so it cannot manufacture EOF or hold output open itself. Cancellation after a
successful builder exit still prevents attestation. This is cooperating
process-group ownership, not containment of processes deliberately escaping
their process group; it adds no product extension interface.

Every ordinary nested wrapper creates a fresh invocation. Only the explicitly
checked isolated external-speech child borrows its live parent's build, outside
both its setup and outer-test deadlines. Direct/unattested hooks rebuild;
standalone coordinated runtime invocations freshly prepare. Shared read batches,
unsupported alternate working directories and watch/hot runs remain unattested.
Ordinary explicit `scripts/build.ts` calls still compile every selected package,
including freshness/configuration/compiler/output-damage fixture controls.

A receipt describes its own build, not whatever `dist` holds later. Every
writer of the shared package output (`scripts/build.ts`, including nested
wrappers, hook fallbacks and the CI build operation, and `scripts/clean.ts`)
first replaces the workspace's random output generation token, before any
mutation. The receipt records its build's token, and admission requires it to
be current. A later successful, failed or cancelled writer beneath the same
lease therefore revokes the outer invocation's authority, and its remaining
hooks rebuild. The token only revokes; matching it never makes output fresh.
`--help` and `-h` reach Bun without preparation.
Client/browser bundling stays fresh and consumers keep their default exports.

Source edits during a run take effect at the next invocation, as explicitly
accepted by the ruling. The lease coordinates cooperating first-party writers;
it does not make source immutable or protect against hostile same-UID processes.
No persistent stamp, boolean skip, generic producer interface, assertion or
deadline change follows. This is distinct from deferred #2319 activation below.
Measure complete preparation, hook admission, test execution and cleanup costs;
small hook durations alone are not a whole-invocation speedup.

### Opt-in compilation within one hosted workspace

The [same-source compilation comparison](https://github.com/schlessera/brain-kit/issues/2321#issuecomment-6233589351)
uses [run 39029776835](https://github.com/schlessera/brain-kit/actions/runs/39029776835),
measurement SHA `742c0c951823233b91116e1836b0a0a1d7354328` descended from
`f33358e6589f72e18099ff2954ebb9ef92cd6ae5`. It compares the original serial
build before the subset implementation and the separately pending stamp work,
with identical compiler/install identities, nineteen-package path/mode/byte
inventories and an offline namespace on each four-vCPU Ubuntu runner.

| Compilation arm | One private workspace (seconds) | Two private workspaces together (seconds) |
| --- | ---: | ---: |
| Serial before / after | 114.005 / 111.228 | 112.898 / 115.539 |
| Two compilers per workspace | 81.078 | 111.200 |
| Four compilers per workspace | 78.132 | Not run |
| Incremental cold / unchanged warm | 113.714 / 36.213 | 115.668 / 39.017 |

Two compilers reduce the one-workspace build by about 28%; four provide only
about three seconds more. The two-workspace gain falls within serial bracket
drift while increasing total user CPU from 338.49 to 404.47 seconds. Therefore
only the hosted pack build and hosted browser/layout/endurance workspace-build
commands select `--jobs=2`. Default, local, release, capture, native and private
two-workspace unit builds remain serial. Hard and optional internal dependency
levels constrain the selected package set; peer/dev closure selection does not
introduce a scheduling cycle. Started peers finish before a named package
failure returns its original compiler exit code. CSS, copies and executable bins
remain part of each package's successful build.

Incremental output is declined: after deleting `common/dist/env-core.js`, all
three actual private workers return zero without restoring that required file.
The unchanged warm gain cannot satisfy the existing output contract. This is
one repetition per arm with serial bracketing, not a whole-CI speedup estimate
or a claim about the newer subset/stamp implementation. Cold means empty output
and incremental state, not cold OS caches. Aggregate memory measurements were
unavailable; process maximum RSS does not establish aggregate headroom. The
measurement workflow remains an evidence vehicle and is not merged.

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
artifacts. Inspect new main commits before refreshing. Confirmation metadata
first applies the existing candidate identity guard after planning and before
product discovery or dispatch (#2118). An already incompatible requested
head/base, checkout or live identity stops the metadata job and prevents its
dependent proof jobs from starting. Draft and synchronize feedback do not run
this admission check. The final candidate gate repeats validation because
heads, readiness and the live base can change after admission; an early pass
does not reserve the base or authorize a merge. Both checks compare the actual merge checkout and immutable GitHub
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

Under #1333, ready-PR metadata can retain every shard of a complete browser or
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

Generated CSS/theme and inclusion self-tests use raw Git blobs from the
independently pinned audited revision for their positive producer controls.
They test actual current producer bytes separately: legitimate audit drift
requires fresh proof and does not redefine the positive fixture. The locked
offline compiler and installed-asset byte/mode controls remain runtime proof.

Browser document, inactive-command and worker-boundary self-tests follow the
same ownership rule. Their positive config, callers, producers and binary font
fixtures come from independently pinned raw Git blobs, including frozen directory
membership (`const owner`, `tests/frozen-browser-source.ts:8-22`). Actual candidate
bytes are checked separately against that owner
(`test.each([...reviewedBrowserDocuments])`, `tests/bound-browser-documents.test.ts:142-155`);
changed enforcement cannot qualify by recomputing its manifest. These fixtures
exercise the existing audit and never refresh production pins or authorize
retained proof for the candidate.

Only a reviewed re-audit moves the audited revision
([#2408](https://github.com/schlessera/brain-kit/issues/2408), maintainer ruling 2026-10-18):

- **Trigger.** A legitimate change to any file in the audited producer table
  (`const auditedProducer`, `scripts/generated-build-inputs.ts`) lands on main.
  That merge leaves the binding unavailable, so proof runs fresh. A separate
  follow-up PR restores it. Drift is not batched indefinitely.
- **Owner.** The audited revision (`const owner`, `tests/frozen-generated-source.ts`)
  must be a delivered main commit. CI reads its blobs offline from full history,
  and a squash merge discards the changing PR's own commits, so that PR cannot
  name itself as the owner.
- **Audit.** The re-audit reviews each changed producer and the combined set's
  guarantees: cleaned package output, the frozen Tailwind dependency, the build
  finishing before browser execution, checked exits and the fresh receipt. It
  records the owner, the changed paths and digests, and the rationale.
  Recomputing a digest is not an audit.
- **Update.** One PR moves the owner, refreshes every matching production digest
  and updates the positive-fixture provenance together. It records two mutation
  receipts, then completes local and hosted proof:
  - a producer-digest bypass fails its negative control;
  - corrupt positive ownership fails its positive control.
- **Drift during review.** A producer that changes again before the re-audit
  merges needs renewed review, or stays unqualified and keeps fresh proof.
  Automatic pin refreshes and per-file ownership are not part of this
  procedure.

The native diagram SVG/PNG/PDF fixture has a separate finite operation binding.
The host launches each engine's native producer in a separate network-disabled,
read-only-root Docker container, using the existing pinned Playwright image's
actual immutable manifest reference. The only host mounts are the private six-workspace
source view (read-only), a private external-package installation (read-only), the
captured installed Bun bytes (read-only), and an initially empty owned output
directory. Its HOME/temp and shared-memory filesystems are fresh container state;
neither the original checkout nor host temporary directories or browser font
cache are mounted. Image and Bun identities join the browser input fingerprint.
Execution bootstrap provisions the exact manifest digest and verifies its
RepoDigest before either producer or browser consumption. Acquisition stays
outside the offline producer and proof lookup.
Metadata lookup projects the explicit manifest reference without requiring a Docker image
on the metadata runner; actual execution requires that exact manifest reference with no pull.
The kernel mount boundary applies to imported initialization and shared library
helpers as well as the fixed entry; their inactivity is not assumed.

The fixture retains the three fixed CLI vectors, literal diagrams-only config,
fresh canonical brain/config roots, exact workspace resolution and immutable
core-command refusal. The source view owns every tracked path, mode and byte in
six workspace families plus exact preparation/entry files. External packages are
copied without hidden package-manager state or unrelated workspace aliases. Their
complete directory membership, package/manifest identities, modes, file bytes and
internal file-link targets are reverified after copying; escaping aliases and
mixed installation origins refuse. Code identity alone does not establish this
closed read boundary: actual absent-host-data assertions and counterfactual host
mounts qualify the mount restriction.

Only a successful, drained native process publishes its artifact identities into
a fresh per-launch handoff directory. The browser validates the preparation
session, checkout, source/installation/runtime identities and all three artifact
hashes, writes those exact validated bytes into its private consumer view, then
retains the original SVG/reference zero-request replay and
raster/font/PDF assertions. Different launches never share a prepared output root.
The browser-side pinned font cache remains a separately owned browser input.

Qualification is tied to the exact operation, source and installed identities;
unknown readers, drift or missing inputs retain complete fresh proof. The fresh
shard independently passes its computed identity to host preparation and checks
installation/runtime identity again before emitting its existing receipt. Both
shards, independent immutable source/current validation and whole-workflow
successful eligibility retain the existing complete-domain protocol. Local proof
is not a hosted baseline, retention hit or permission to use a failed workflow.

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

Diagram capture binds all six exact renderer, axis, positional, node-link,
callout and scene-bounds callers and their complete call-site inventories,
closed SVG primitive producers,
literal adopted fixture, generated consumer CSS and locked inline-font inputs.
Its additional replay page contains that source-owned document, aborts and records
HTTP/websocket requests, and checks the zero-request invariant after document and
font loading and after capture. Unknown DOM or resource origins remain unresolved;
source or producer drift requires fresh execution and a new audit. The
scene-bounds caller owns one literal origin-group fixture and two literal
annotation variants. Its client/static/flattened renderers share the closed
primitive producer; the fixture, flattening dependency and changed geometry,
annotation and painter sources are pinned explicitly. This audit does not
qualify native retention or replace complete fresh runtime proof.

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
and modes, selected discovery ownership/order, the domain's measured partitions (`PROOF_SHARDS`) and
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
Discovery has a fixed 30-second wall-clock maximum for the native child to exit
and both output pipes to drain (`browserInventory`, `scripts/proof-inputs.ts:81-139`),
in local preflight and hosted metadata,
fingerprinting, reuse lookup and aggregate validation. The maintainer selected
option A under [#2380](https://github.com/schlessera/brain-kit/issues/2380) on
2026-10-22: #2326's cold discovery sample took 14,811 ms in the pinned offline
image with two CPUs, so 30 seconds allows approximately twice that observed
duration. Hosted metadata steps had completed in 6–11 seconds. This bounded
margin does not guarantee completion under arbitrary CPU starvation; a stuck
child can take up to 15 seconds longer to fail than under the previous maximum.
Process controls inject a short deadline and assert the default separately;
the integration test allows additional time for ownership scanning and cleanup.
Discovery failure still rejects unsuccessful inventories and retains the
caller's existing fresh-execution or fail-closed behavior.
A missing immutable Git object has an eight-second bounded fetch.
Runner image context comes from the image's
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

## Exact-candidate integration reservation

The maintainer rulings on #2111 select cooperative coordination for expensive
confirmation and main merges. One reservation covers exactly one repository,
PR, head SHA and base SHA, with an authenticated numeric GitHub actor ID. It
lasts five minutes, renews every minute and expires absolutely sixty minutes
after acquisition, including runner queue, proof and merge time. Renewal never
resets that cap. A changed head/base, terminal failure/cancellation, abandonment
or delivery releases ownership; a stopped process loses it after its last
five-minute term. An expired or superseded identity cannot renew itself or
release a successor.

The shared command is `bun scripts/integrate.ts`. Its authoritative state is
`reservation.json` in `refs/heads/brain-integration-reservation` on origin.
Each update is a commit parented by the inspected remote state and pushed with
an exact `--force-with-lease` comparison, including absent-ref acquisition.
Competing snapshots cannot both acquire. Git history retains acquisition,
renewal, release and explicit revocation records. Expiry uses a fresh GitHub
HTTP Date response, requested without caches, with no local-clock fallback.
Malformed state, unavailable time or transport errors fail closed. Public state
is leakage-screened before publication. The active record shows owner,
candidate, expiry and absolute cap; busy callers get that record and at most
three attempts with bounded backoff. There is no persistent or FIFO queue.

Use `confirm <pr> --issues owner/repo#N,...` before requesting costly ordinary
candidate proof. The command acquires, requests draft-to-ready confirmation,
renews while waiting, and calls its shared merge path after success. Nonowners
may code and run fast feedback but must hold competing confirmation and merges.
For a separately managed proof window, `acquire <pr>` returns the explicit
lease ID; its owner must run `renew <id>` every minute and later
`merge <pr> --lease <id> --issues owner/repo#N,...`. `release <id>` abandons
it. `inspect` is read-only. A maintainer may `revoke '<reason>'`, recording
actor, server time, reason and former candidate; a replacement needs its own
reservation and passing confirmation. Revocation is never a proof waiver.

The merge path independently reads canonical head-specific CI and contract
runs, complete attempt/job inventories, structured validated selections,
intentional skips, matrix partitions and actual checkout logs. Missing or
failed selected jobs, mismatched receipts/checkouts, stale live identities,
missing issue milestones or wrong lease ownership reject before merging.
Immediately before the matching-head squash it rechecks the live exact
candidate and reservation. It then verifies the actual squash parent/tree,
main ancestry and PR/issue milestones and releases ownership. Exit 2 after a
successful squash explicitly leaves automatic main proof to the existing
actual-job/checkout reconciliation procedure; even a green run summary is not
claimed as completion. Failures exit 1, with best-effort owned cleanup.

This is mandatory cooperative procedure, not an atomic GitHub branch lock.
Direct API/UI merges under existing permissions can bypass it or race the
final read; actual squash checks still own reconciliation. No protection,
permission, provider or native merge-queue change is introduced. Native stack
candidates remain unsupported by this command pending separately qualified
prefix integration; do not flatten them into an ordinary receipt or bypass
reservation policy. A reservation never qualifies several layers at once.

Offline controls use real concurrent remote Git pushes, actual executable
merge sentinels, and isolated authoritative-clock fixtures for expiry,
automatic renewal, cancellation, revocation and the hard cap. They establish
local behavior only. Hosted integration qualification and measured savings
remain outstanding on #2111: historical invalidations and cancellation costs
are preserved there, not relabeled as a controlled speedup. A runner queue
longer than the hard cap cannot be solved by renewal or an implicit extension.

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


## Fixed CI build output reuse

The [isolated build decision](isolated-ci-build.md) records the maintainer's
#2319 rulings: retain the dormant fixed first-party operation and defer activation,
preserving ordinary rebuilding for local and unsupported contexts. CI intent stays
off, production remains unqualified, and the original optimization criteria stay
open after the independently reviewable dormant delivery. CI intent does not
authorize reuse. Complete effective inputs, drained output ownership, actual
consumer compatibility and comparable hosted cost must be qualified before
activation. This does not cache selected test results or relax their proof.

## Read-only timing archives

The user-requested cross-PR collection in
[issue #2476](https://github.com/schlessera/brain-kit/issues/2476) adds one scheduled/manual
measurement workflow, separate from authoritative contribution CI. It runs
trusted default-branch tooling with read-only Actions, contents and PR access,
parses candidate logs only as data, and archives normalized observations for
90 days. Hourly two-day windows seed normalized snapshots from the preceding
default-branch artifact and collect only new/incomplete attempts. Scheduled
resource-log downloads are omitted. One serialized API client enforces a
200-request invocation ceiling, reads remaining quota and leaves a 500-request
reserve for authoritative CI. Expected budget stops archive an explicit partial
coverage gap and exit successfully. Discovery ends 15 minutes in the past;
discovery and reservation-history failures remain visible without discarding
other timing observations. Explicit backfill is needed after longer outages
or reruns of older runs. Workflow lint admits
this narrowly scoped collector while retaining the existing CI/provider gates.

The [collection guide](../process/ci-timings.md) defines interval/attempt
accounting, missing evidence, cancellation costs, PR attribution and the
historical exhaustive-run proxy. Estimates remain distinct from same-source
paired measurements. Timing metadata never authorizes proof retention or merge.

The expanded [issue #2476](https://github.com/schlessera/brain-kit/issues/2476)
objective is reliable parallel agent throughput. Collection
joins lifecycle, first-main outcomes, recovery observations, queue/concurrency,
reservation history and explicitly supplied work/incident records. The primary
descriptive proxy is first-pass green integrations/day, accompanied by cost and
latency per delivered cohort. Empirical green rates do not establish formal
guarantees; proof evidence coverage, unknowns and scenario assumptions remain
separate. Actual agent activity and diagnosed regressions require explicit
records. Optimization still preserves existing assertions, guards and matching
candidate proof, with causal claims requiring comparable measured inputs.
