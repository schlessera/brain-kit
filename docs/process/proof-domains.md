# Product proof domains

Default execution ownership is discovered, not copied into a static test
allowlist. `bun run test:inventory` writes `tmp/proof-inventory.json`; CI publishes
it with the metadata artifact. Each row has a runner/project/file identity,
its domain, source test declarations and assertion line locations. An assertion
inside a parameterized test runs for every collected case: the inventory does
not pretend source declarations are runtime test counts. Actual suite reports
remain authoritative for collected cases, skips, assertions and outcomes.
Imported/shared helper assertions retain their existing callers and full runs;
the source-location index is navigation, not a completeness proof by counting.

Execution ownership applies to every expanded case and its assertions, including
conditional branches, parameter tables, Storybook inherited play functions and
helper calls. Their owner is the discovered runner/project/file instance that
executes them. The identity includes the project: the same story in light and
dark is two intentional executions. Within a project, identical display names
can also be distinct cases; Vitest task IDs distinguish their declaration order.
These IDs are receipt-local navigation, not stable identities across source moves.

Hosted browser/layout/endurance commands retain the normal human reporter and
publish `tmp/proof-cases.json` with their existing artifacts. It records the Git
checkout, requested files before sharding, cases observed at collection, final case states and
durations, and module/unhandled errors. Unlike `vitest list --json`, it retains
skipped cases. The outer wrapper captures and rechecks host Git identity; its
internal `BRAIN_PROOF_CASE_CHECKOUT` transport lets a mounted worktree report
identity without resolving host-only `.git` paths inside the container.
`caseReportProblems` compares the report with the independently
requested project/file domain, executed partition and expected checkout, then refuses missing or
duplicate files/cases, skipped or unfinished cases, errors and stale identity as
complete reconciliation evidence. This diagnostic does not replace the runner's
exit status or make a skipped required assertion passing.

After downloading a job's artifacts, run the diagnostic explicitly:

```sh
node scripts/proof-case-report.mjs --check proof-cases.json selected-specs.json proof-checkout.json
```

`selected-specs.json` uses a versioned object with `version: 1`, `requested`
and `executed` arrays of `{ "project": "…", "file": "packages/…" }`. Derive
`requested` independently from the metadata inventory and recorded project/file
filter, and `executed` from the installed sequencer's selected partition (also
recorded in reusable browser/layout input receipts). Vitest calls `onTestRunStart`
before sharding, so the raw report's `selected` field describes the whole
requested domain; `collected` and `modules` describe the executed shard. The
diagnostic checks both domains separately, requires unique nonempty selections,
and rejects execution outside the requested domain. Never derive either expected
selection from the report being checked.

For unsharded endurance, take every endurance row from the metadata inventory;
requested and executed are equal. The original array input remains shorthand
only for unsharded commands, with that same equality requirement. `proof-checkout.json` is the command's
separate Git checkout receipt. The diagnostic exits nonzero on unresolved
evidence; the candidate aggregate does not invoke it automatically.

Reconcile each final command as follows:

1. Keep its actual checkout/tree/parents and input selection with the report.
   Compare every selected project/file against the metadata discovery and shard
   partition; compare every collected task with its reported outcome. For Bun,
   use the complete unit command's JUnit cases and file inventory; there is no
   collection-only mode in the pinned Bun CLI. Native scripts retain their named
   command/probe receipts rather than being invented as Vitest cases.
2. Record skipped, todo, conditional, failed and uncollected cases separately.
   A completed collection is not assertion execution. A missing report after
   cancellation is missing proof. Historical reports retain their source identity.
3. For moved or reduced cases, map each original observable assertion and shared
   helper obligation to its replacement, parameter cells, runtime boundary and
   independent oracle. Preserve real failing-first or mutation/restoration receipts.
   Neither source `expect` counts nor expanded case counts prove equivalence.
4. Read the runner exit, all selected job outcomes and final candidate aggregate.
   A case report alone cannot establish that every required command ran or that
   later base/source changes are covered.

| Existing scenario family | Default domain | Intermediate push | Final candidate |
| --- | --- | --- | --- |
| Curated contract/integrity files in `FAST_TESTS` | Fast | Affected subset with strict types | Included once by complete affected unit discovery |
| Every other product Bun test in `packages/` and `tests/` | Unit confirmation | Deferred | Complete affected discovery plus root tests |
| Storybook dark/light, visual, pointer and isolated browser projects | Browser confirmation | Deferred | Every discovered project/file instance in the existing two shards |
| `.layout.tsx` and `.offline.tsx` in `ui-react-layout` | Layout confirmation | Deferred | Every discovered project/file instance in the existing two shards |
| `.endurance.tsx` in `ui-react-endurance` | Endurance confirmation | Deferred | Every discovered file in a separate concurrent job |
| Native permission/enforcement/delegation/capability/host/cleanup probes | Runtime confirmation | Deferred | Existing complete command inventory and offline namespaces |
| Packed consumer probes and editorial capture verification | Packaging/capture confirmation | Deferred | Existing affected commands, pins and artifacts |

A project/file instance is a distinct execution: for example, the recordings
tray's layout and three native pointer cases intentionally remain separate.
The same scenario is never assigned to both ordinary and endurance projects.
Unknown ordinary tests join full confirmation; unknown browser costs are listed
as unmeasured, never skipped. A `.endurance.tsx` outside the endurance project,
a duplicate project/file identity, or an undiscovered browser leaf fails metadata.
The separate endurance project never participates in ordinary shard balancing.
#1836 owns broader cost-table refresh; this split does not invent new weights.

The classification follows purpose and measured cost, not an arbitrary duration
cutoff: native browser/media/permission and packaging proof needs its complete
environment; fast feedback is the existing curated keyless contract/integrity
subset. The recording cap's measured ten-minute real media path has a temporal
claim that short deadline logic alone cannot establish. No assertion moves to
an optional command. Adding a long temporal scenario requires explaining its
wall-clock purpose and retaining final confirmation; all unknown cases are
conservatively final until deliberately classified.

## Selecting browser categories

Browser, layout and endurance start from the installed Vitest file discovery and
the Vitest/Vite/Storybook configuration, including imported command modules.
Captures start from `scripts/capture.ts`, `scripts/captures/` and the capture
catalogue. Repository static imports use TypeScript's installed module resolver,
including workspace exports and the Bun condition. Literal dynamic imports are
traversed; computed loads and recognized process/file inputs require exact-call
indirect declarations with real transitive targets. Asset imports remain inputs.
Unsupported CSS/build input syntax conservatively keeps the broad category.

The declaration files beside each harness are `packages/ui-kit/tests/proof-inputs.json`
and `scripts/captures/proof-inputs.json`. Declare every actual fixed input of a
spawned/generated entrypoint, not only its launcher. A directory target includes
new descendants. Validation refuses absent targets, changed call sites, duplicate
or unused ownership, and empty target lists. A declaration is not an exception
for arbitrary user-selected paths; unresolved inputs retain the previous broad
selection. The category still executes every discovered project/file when selected.

For read-only replay, supply the shared 100-PR snapshot with immutable squash SHAs
and complete `git diff --no-renames SHA^ SHA` paths:

```sh
bun scripts/replay-browser-selection.ts snapshot.json report.json
```

The tool verifies every diff and emits per-PR before/after selection, the list of
omitted browser plans, complete category closures and unresolved-edge diagnostics.
It compares current selection rules over historical changes, not historical source
execution or elapsed performance. Closure graph hashes describe paths and diagnostics,
not source bytes or passing-proof fingerprints. Keep the actual source identity
with its report; proof retention requires its separate immutable input validation.
Schedule/manual proof is exhaustive; push proof remains complete affected proof.

## Recording assertion mapping

#1853 separates short limit correctness from native duration endurance. Apart
from the moved duration-cap and nine-minute-warning scenarios, every test in
`recordings.offline.tsx` remains ordinary layout proof, including
quota failures, auth/partition boundaries, interrupted/reloaded pages, tab
ownership, microphone/update-hold ordering and cleanup. Short threshold and
warning logic lives in `recording-limits.offline.tsx` with real media proof.

The original “the 10-minute-5-second fixture stops at the hard duration cap
with warning, copy and playable audio” scenario moves to
`recordings.endurance.tsx` as “ten-minute native endurance preserves sustained
commits, full-length decode and resource cleanup”. All original assertions
remain; the extracted scenario additionally proves sustained sequential commits,
chunk continuity and byte totals, complete-content hashing, microphone/lock/
update-hold release, and playback URL revocation. Its assertion mapping is:

| Retained assertion/obligation | Execution |
| --- | --- |
| Real generated 10m05s microphone input and native MediaRecorder encoding | Endurance |
| Automatic completion before 605000ms with the original 650000ms test deadline | Endurance |
| Persisted saved-through boundary greater than 598000ms and at most 600000ms | Endurance |
| Exactly one warning and the exact saved-at-limit message | Endurance; short correctness separately tests deadline transitions |
| Persisted playback URL and native AudioContext decoding | Endurance |
| Decoded duration greater than 598s and at most 600.1s | Endurance |
| Microphone restoration, playback revocation, audio context closure, store/root disposal | Endurance, with all registered fixture cleanup attempted even after one cleanup fails |

The nine-minute-warning scenario moves into the exact-timer scenario below. Its
original pre-boundary absence, exact warning payload and single-warning assertion
remain, including later advancement through and beyond the deadline. The five
ordinary `recording-limits.offline.tsx` scenarios own these assertion families:

| Scenario | Assertions and native boundary |
| --- | --- |
| Registered warning/deadline finalize short native audio | Two real MediaRecorder commits precede callback invocation; registration is at 540000/600000ms; warning and final copy match independent literals; saved metadata is positive and below 10s; microphone ends, active/busy/update hold clear and the real recording lock is reacquirable; a fresh store recovers the same row; native decoding exceeds 0.25s and agrees with persisted duration within 150ms; revoked playback URL fails. This proves the production stop path, not native ten-minute elapsed time. |
| Exact warning/deadline times | Production limit equals 600000ms; warning/stop remain absent at 539999ms; exact warning payload appears one millisecond later; stop remains absent at 599999ms and receives `limit` at 600000ms; later advancement cannot duplicate either callback. Only registered timeout scheduling is controlled. |
| Cancellation and fresh deadlines | An ended recording's pending warning/deadline never fires; the next recording gets its own complete 540000/600000ms schedule, with absence immediately before each boundary and the expected callback at it. |
| Durable duration boundary | Native IndexedDB commits 599999ms and exactly 600000ms; the 600001ms chunk triggers `limit`; metadata retains two chunks/two bytes/600000ms; persisted chunks end at the accepted boundaries; playback contains exactly `ab`, excluding rejected bytes. Synthetic blobs prove admission, not native encoding. |
| Aggregate byte boundary | Independent 104857600-byte oracle spans readable account, other account and unassigned audio; exact boundary commits, the next byte fails with storage copy/reason; retained metadata and durable blob total match the cap; older partitions remain unchanged. No native ten-minute endurance claim follows from synthetic bytes. |

The endurance case adds sustained sequential commits (more than 500), equality
between commit events and persisted chunk endpoints, contiguous indices/times,
positive chunk sizes, aggregate byte equality/cap, and a SHA-256 comparison over
the complete playable bytes. Native track termination, inactive/not-busy state,
released update hold/recording lock and revoked playback URL complete its resource
assertions. Chunk-loop assertions execute once per actual native chunk; their
execution count is data-dependent and must not be inferred from source lines.
Each recording cell retains a fresh root, store and unique IndexedDB namespace.
Fixture disposal is not a claim that the database is explicitly deleted or that
peak memory was measured.

The old file's temporary side-effect import is removed when standalone discovery
lands, so the long scenario executes once. The split preserves the browser pin,
`--network=none`, real APIs and product limits. Full local checks include both
ordinary and endurance commands; standalone commands remain convenient.

## Independent tiers

Experiment-only harness tests stay under `experiments/` and the release-time
`test:experiments` policy. Paid live-provider tests remain explicit opt-ins and
unmeasured here; they are not product endurance. Neither tier is admitted into
ordinary product discovery by renaming a file.

Native negative observation windows remain candidate confirmation when the
assertion is that a browser process or asynchronous receiver does not act during
that interval. For example, focus/save/send and navigation/download denial
windows are not endurance merely because they consume wall time. Controlled
deadline logic can be fast ordinary proof while native transport, process freeze,
storage and media boundaries retain their real environment. A census of wait
source lines is not a count of executed waits or a reason to change their tier.

## Resource and scheduling reconciliation

Keep checkout/tree/parents, run/attempt, actual job checkouts, selected commands,
runner image, CPU/memory capacity and browser pin with each measurement. Compare
like source and selection where possible. Different-source historical runs are
context; never sum local case savings into a claimed CI critical-path reduction.

| Quantity | Definition and limits |
| --- | --- |
| Setup | Actual checkout, tool installation, dependency installation, native prerequisites and cold-start steps. Category command timing does not include all these phases. Workspace build appears as its own command phase. |
| Command and case time | `proof-resources.json` records sequential command wall times; case reports contain runner case durations. Their sum is not suite elapsed time when cases overlap. A failed command still records its elapsed phase. |
| CPU and memory | The category sampler records VM-wide active CPU delta and used memory sampled each second, including baseline/background/container use. This is not process maxRSS, an exact peak, or isolated test CPU. Compare both runner capacity and measurement scope. Fast/metadata jobs currently have job/step timing only. |
| Runner consumption | Sum actual executed jobs' start-to-completion intervals, including failed and cancelled running jobs. Identify execution from steps/logs. Queued cancellations with zero executed steps and no logs can carry synthetic API start times; record them as queued, not consumed execution. Unknown execution remains unknown rather than zero. |
| Queue and critical path | Record run creation, job eligibility/dependency completion, actual job start and final completion separately. Creation-to-first-start is initial queue; creation-to-aggregate-completion is end-to-end elapsed, including queue. A queued aggregate is pending, even if predecessor jobs passed. |
| Cancellation waste | Report the executed portion of superseded runs separately from useful final proof; it is a subset of runner consumption, not an additional amount to add again. State which workflows are included. |

Browser/layout/endurance jobs use separate runners and retain the existing
per-project file concurrency bound. The endurance split does not authorize more
within-browser concurrency. A final overlap receipt must show selected job
intervals, command resources and cleanup outcomes before claiming the split
improves elapsed time or resource use.

For cadence, identity validation and required evidence, see
[the CI decision](../decisions/ci-utility.md) and [testing](testing.md#required-proof-for-a-pr).
