# Mechanical hygiene: source discovery and offline evaluation

This investigation for [#842](https://github.com/schlessera/brain-kit/issues/842)
examines moving two Phase 3 edits into deterministic CLI operations. Source was
inspected at `44be3840f9fb74ea3ce62ebd6f65696aee745863` on 2026-10-02.
The private evaluation writes only disposable fictional brains. It adds no
production command, changes no skill, and selects no adoption policy.

## What already exists

| Operation | Existing owner | Consequence for this evaluation |
| --- | --- | --- |
| Audit, silent-edit and row-level table detection | `detectCandidates`, `packages/core/src/lib/hygiene.ts:596-639` | Reuse detection rather than parse finding messages into write instructions. |
| Stable finding IDs | `hygieneId`, `packages/core/src/lib/hygiene.ts:172-175` | Keep category/path/evidence identity; add no parallel log. |
| Open/snoozed/resolved reconciliation and failed-check protection | `reconcile`, `packages/core/src/lib/hygiene.ts:1168-1477` | Reuse the existing reconciler after repair and retain its manual-state tests. |
| Generated registry planning and application | `applyRegistry`, `packages/core/src/lib/index-registry.ts:288-317` | Leave owned tables to `brain registry`; this evaluation never regenerates them. |
| Date and eligible Status table edits | `## Phase 3`, `packages/core/skills/content-hygiene/SKILL.md:94-121` | Still agent file edits. These are the two prototype operations. |
| Completion-based audit suggestions | `suggestFixes`, `packages/core/src/cli/commands/audit.ts:26-67` | Suggestions only; this is not a mechanical repair handler. |

Neither current hygiene detection nor validation detects the `updated < created`
ordering itself. Validation checks the presence of the fields (`if (!data.created)`,
`packages/core/src/lib/validate.ts:204-219`); the prototype must inspect source
dates in addition to reusing existing table detection. A parsed YAML `Date` is
insufficient: invalid calendar dates can normalize, and timestamps lose their
original precision when reduced to a date. The prototype checks lexical date-only
source values and their calendar round trips before planning.

[#597](https://github.com/schlessera/brain-kit/issues/597) has settled ordering,
canonical identity and evidence-invalidation policies, recorded in
[hygiene-review.md](decisions/hygiene-review.md). Its category repair handlers,
interaction design and runtime integration remain separate work. There is no
shipped date/table review handler to duplicate. Reuse its shared approved effect
lifecycle when a production repair is integrated; repair is not Dismiss, Snooze
or notification acknowledgement.

## The private prototype

`scripts/evals/mechanical-hygiene/` combines the real indexer, `detectCandidates`,
a private planner/applier and the existing `reconcile`. The real CLI dry-run is
also exercised. Markdown is authoritative; each evaluation database is in memory.
The normal keyless test transport guards remain active.

Date repair sets both fields to the maximum of created, updated and the original
file mtime's UTC day, only when updated precedes created. UTC follows the existing
`isoDay` convention (`isoDay`, `packages/core/src/lib/auditor.ts:216-218`). Separate
processes in UTC, Honolulu and Kiritimati produce identical expected bytes.
Comments, quotes, body content and CRLF endings survive.

Table repair deliberately accepts only a top-level plain pipe table with one
explicit relative Markdown link per row, unique known columns, supported statuses,
and unambiguous current detail files. Status must be the only differing semantic
column; Updated must be older. A differing Title, an unknown/duplicate column,
duplicate target, wiki-link, excluded detail or unsupported syntax refuses the
whole file, including any otherwise eligible row. Updated-only drift remains
report-only because Phase 3 only specifies a Status repair. Generated markers or
registry metadata refuse hand edits, including date edits on that index.

Configured inbox paths, archived path segments, archived status, excluded paths
and hygiene logs are ineligible. The entire input snapshot precedes detection.
Application rechecks source bytes, mtimes, regular files and every parent path
before any batch write, including read-only detail inputs. The existing reconciler
also validates the log in dry-run mode before the first content repair; a malformed
log cannot leave repaired content behind when reconciliation refuses it. A stale input vetoes
the batch. Dry-run writes neither content nor logs; index refresh is still allowed,
as in the existing CLI. A fresh second cycle produces no content, log or timestamp
diff. Failed checks prevent prototype repair; the reconciler retains its existing
failed-check and manual snooze/resolution behavior.

This is not a crash-safe multi-file writer. It reuses the existing conditional
single-file replacement and attempts rollback after synchronous failure. A change
between a preflight check and replacement, interrupted rollback, newly introduced
files/configuration and process death require production lock/recovery design.
Those limits prevent unattended adoption from these controls alone.

## Measured controls

Run without keys or network:

```sh
bun run test tests/mechanical-hygiene-eval.test.ts packages/core/tests/hygiene.test.ts packages/core/tests/registry-regions.test.ts tests/decision-citations.test.ts
bun scripts/evals/mechanical-hygiene/run.ts
bun run typecheck
bun run lint
```

The frozen draft fixture SHA-256 is
`dab00d2da767e9bca46590e99acd4c03a04cbb1da44d4cea9e79c2f20fd67689`.
There are 24 fixture cases with exact expected source bytes: 4 tuning controls
and 20 draft held-out controls. They are synthetic boundary controls, not an
independently approved representative workload. Independent golden review is
required before a live comparison; no threshold was tuned on the held-out labels.

| Observed outcome | Private deterministic prototype | Current CLI without an agent |
| --- | --- | --- |
| Exact expected content agreement | 24/24 | 20/24 |
| Unintended content writes | 0 | No content repair is implemented |
| Unchanged-file mtime churn | 0 | Not a model-efficiency comparison |
| Second-cycle content/log/mtime diffs | 0 | Existing reconciler is covered separately |
| Dry-run content/log/mtime diffs | 0 | Real CLI dry-run preserves Markdown |
| Inference calls | 0 | 0 |

The CLI control executes its existing index/detect/reconcile functions on the
same inputs; it leaves the four eligible repairs undone. It is not a measurement
of today's full content-hygiene skill or its agent's judgments.

Local Bun 1.3.14 timings cover index, detection, private planning/application,
post-repair index/detection and log reconciliation, excluding fixture creation.
Each size has three fresh-brain repetitions and one same-brain no-op cycle after
each. Counts below are initial source documents, before hygiene log creation.

| Initial documents | First cycle p50 / p95 | Repeated cycle p50 / p95 |
| --- | --- | --- |
| 20 | 112.0 / 113.4 ms | 34.6 / 36.0 ms |
| 1,000 | 12,081.3 / 12,603.0 ms | 2,315.0 / 2,429.7 ms |

Raw first-cycle samples are 112.02, 107.67, 113.42 ms and 10,061.51, 12,603.01,
12,081.30 ms respectively; repeated samples are 34.08, 34.64, 35.98 ms and
1,527.94, 2,429.68, 2,315.05 ms. With three samples the nearest-rank p95 is
the maximum, not a stable tail estimate. This is local runtime evidence, not a
deployment benchmark. There is no model cache measurement.

Five restored runtime mutations establish that the tests can fail for their
claimed reason. Disabling all repair fails the date fixture at its expected
file bytes. Removing exclusion fails the inbox fixtures at unchanged file bytes.
Ignoring the other-column mismatch fails the multiple-column fixture at its
unchanged index bytes. Ignoring stale preflight fails the changed-detail fixture
at its complete before/after Markdown snapshot. Removing log preflight fails the
malformed-log case at its unchanged content bytes; this assertion also failed on
the initial prototype before the preflight was added. Each mutated program loads and
runs; none of these receipts relies on a missing export or earlier setup failure.

## Recommendation and prospective contract

Continue evaluating deterministic date/Status repairs, with conservative refusal
for unsupported cases. There is no classification question needed to compare
these dates or enforce exact table invariants. This inference from the source
and offline controls agrees with the distinction between atomic judgments and
code composition in [TypeSafe's introduction](https://docs.typesafe.ai/introduction)
and its [documented model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
checked 2026-10-02. It does not establish real agent savings or production safety.

A possible implementation would add opt-in `brain hygiene plan --json` and
`brain hygiene apply --plan <file> --json`. Planning should return structured
operation kinds, exact affected paths/fields, source and configuration evidence,
refusals and failed checks. Applying must recompute approved bounded edits rather
than accept arbitrary replacement bytes from a plan, revalidate all premises
under the shared writer lock, expose stale/unsupported outcomes, preserve durable
operation receipts and reconcile only confirmed repairs. Keep the existing
reconcile/list envelopes, stable IDs and manual dispositions intact. These names
and shapes are proposals, not an implemented or approved public contract.

Such new CLI/JSON operations are additive contract work: a `CONTRACT:` commit,
same-commit integration-contract documentation and minor changeset are required.
Any changed existing envelope, date semantics or state meaning needs a separate
compatibility assessment and a maintainer ruling if breaking. No new provider,
seam, default cron action, semantic conflict replacement or derivative regeneration
belongs in this scope. Production handler work must be coordinated with #597
rather than create a second review engine.

The adoption gates for the eventual comparison are 100% exact accepted diffs,
zero wrong-target/content-loss/permission errors, zero unintended writes or
unchanged-file timestamp churn, preserved dry-run and repeat behavior, all guard
mutations failing as intended, and a measured end-to-end reduction in agent work
without worse task outcomes. Ambiguous cases must abstain. Today's real agent
baseline, all input/output/cache tokens, retries/fallbacks, billed/effective cost,
model-call reduction and comparative latency remain unmeasured. Access to the
approved provider/account/model and a total spend ceiling must be recorded on
#842 before that evaluation, following #838. Ordinary CI remains keyless.

## Comparing complete effects

The unchanged 24 boundary controls are distinct from an authored 18-case
workload: six Ogygia cases and twelve Ithaca/Pylos/Sparta cases. The latter
include three positive table repairs and explicit UTC calendar boundaries under
Honolulu and Kiritimati workers. The row detector identifies a finding by the
first cell, so supported positive tables keep the explicit link first while
varying the other columns. Entity separation and different surrounding prose
provide directional coverage; shared table grammar does not demonstrate
unseen-template generalization. Every new expected document remains subject
to complementary review.

The observer retains every filesystem entry, including binary bytes, deleted
and created files, complete logs, permissions, timestamps and symlink targets,
without following symlinks. The effect checker requires exact approved bytes
and permissions for each file; a hygiene directory prefix cannot approve an
arbitrary write. Unchanged files also retain their timestamps. Complete
reconciler log candidates are generated with the real detector and reconciler
for independent review. These source-derived log candidates are explicitly
provisional, rather than independent goldens or automatic write approval.

The comparison admission state machine retains failed native receipts and
refuses the next phase after unknown usage, wrong model or route, unadmitted or
unobserved overage, incomplete closure or an unexpected filesystem effect.
An undrained writer has no safe final snapshot; its receipt is preserved with
that snapshot absent. Modeled driver controls establish those stop boundaries only. Separate actual
native controls now exercise the same complete cycle collector used for the
prospective comparison, with scripted responses in a network namespace that
contains only loopback. They establish transport/tool/closure behavior, not
Claude quality or semantic approval of the authored workload.
API-price equivalents remain separate from actual subscription billing.

The private protocol defines fresh native sessions for dry-run, apply and
same-brain repeat phases, three repetitions, and materialized 20/1,000-document
states. It includes startup and complete runtime work in timing, keeps the
original file mtimes and pinned document date, and distinguishes native cache
observations from claims of cold provider cache. These controls neither ship a
production repair command nor decide unattended adoption.


## Protected actual skill experiment

The native baseline executes the unchanged shipped content-hygiene skill through
SDK 0.3.292 / CLI 2.1.292 with a private fixture hook policy and an isolated home.
It does not measure the unmodified core runner's implicit auto permissions or
production classifier overhead. All observed physical and auxiliary requests
are retained and must serve the pinned Sonnet 5.5 model. Unknown route, model,
usage, overage or completion evidence stops later admissions. The private
development alias resolves and executes the actual 292 pair independently of
the public backend's 293 dependency. Historical 293 offline compatibility
receipts do not supply proof for the 292 live arm.

Active extra usage requires a matching root-issued source, runtime, proof and
prompt policy for #842, an atomically consumed one-use grant and the existing
serialized root window. The original $15 issue and $150 aggregate actual-charge
allocations and unknown reservations remain authoritative. No new pool is
created by this instrument. Before releasing USER input, the allocation must
hold the full supported million-token context and maximum output; before each
physical request, the relay reserves that context and its exact output cap.
Wire bytes constrain transport only. Missing usage or incomplete/failed streams
retain the full unknown hold and stop forwarding. Complete raw usage gives a
conservative price upper bound, never an invoice or account-wide spend reading.

The isolated native settings disable attribution so the harness cannot append
an unreviewed USER reminder. Exact frozen USER checks, the original fixture
tool hooks, real native clocks, deadlines and model/runtime pins remain in
force. Preserved upstream and native bytes independently reconstruct usage,
init, quota events and terminal output. Scripted paid controls cannot become
semantic approval by changing their receipt labels; the original consumed grant
binds their offline provenance. Every source change invalidates old packets.

Only brain CLI child tools preload the exact July 12 noon UTC fixture clock.
The native SDK, authentication, subscription entitlement, provider, timers and
performance clock remain real. Real CLI controls exercise detection, complete
logs, reference dates and repeated no-op behavior at both document sizes under
UTC, Honolulu and Kiritimati. The readonly source mount supplies runtime code;
a real outside-fixture read is denied before its bytes reach model-bound input.
A mutation that permits that read reveals the controlled sentinel to the model
transport and fails the named assertion.

The physical relay stores literal request and response bytes before decoding or
forwarding, including binary HTTP failures and malformed streams. Decoded SSE
frames are a separate interpretation. It records natural EOF, cancellation,
owned reader closure, terminal per-request usage and final native reconciliation.
Known API-price subtotals remain separate from unknown aggregate costs and final
invoices. A streamed split-codepoint control preserves Unicode and the final
unterminated frame; real HTTP cancellation and shutdown controls prove upstream
abort and local closure. An owned process that ignores SIGTERM is forcibly killed
and its actual close/stdout completion awaited before any post-write snapshot.

The full collector takes a complete input snapshot before each phase and checks
all source bytes, modes, original mtimes and membership before dispatch. Unexpected
files or directories, symlinks, stale input, wrong source edits, unapproved log
bytes or unchanged-file churn veto subsequent phases. Disposable SQLite and two
exact scratch files have separately checked grammars and retained complete bytes.
They do not authorize arbitrary files under a directory prefix.

Complete provisional reconciler logs fix paths, identities, membership, counts,
dates, dispositions and all surrounding bytes. Actual fix descriptions can vary
only in their explicitly reviewed slots for the exact approved changed paths.
The collector projects these slots from the actual scratch descriptions and the
pre-reviewed structure; it never copies an observed log into its own expectation.
Description quality remains false until a separate source-aware annotation binds
the full actual description and receipt. Structural agreement alone cannot finish
the comparison or produce an adoption recommendation.

The deterministic schedule has 108 cycles per arm (18 cases, two sizes, three
repetitions), each with dry-run, apply and same-brain repeat phases. Both arms
rotate their order; each native phase uses a fresh protected model session.
Source/fixture preparation and complete dependency/source admission scans are
excluded from workflow timing; their separate harness wall duration is retained.
The freezer binds all workspace source/manifests and the complete installed
dependency byte/mode/link closure, including native and Bun executables. Every admitted native cell
requires all exact source/case packets approved and the root's current quota,
actual-charge allocation and serialized-window intent. The preparation and matrix
scripts do not change production behavior. The full fresh live comparison and
independent actual-description annotation remain necessary to assess model work
and end-to-end savings; the keyless controls supply neither result.


The CLI reference clock does not change physical filesystem mtimes. Both fixture arms keep real write dates. Each preparation and all packet approvals bind the actual UTC write day; stale dates and midnight rollover stop write admissions and exclude partial completion. A fresh day requires fresh candidate effects, proof and full complementary reviews. Native work is refused near UTC midnight for its full deadline plus owned-drain margin; admission hooks cannot atomically interrupt an internal write already in progress. Every surviving partial effect and its process drain remains evidence.

Consequently a July document repaired on the actual later write day can produce a new `silent-edit` finding. That literal finding and every full log byte remain in the effects and review inputs as a harness consequence. They are excluded from substantive repair-quality improvement. No timestamp normalization or production writer policy is introduced.
