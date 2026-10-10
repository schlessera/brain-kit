# Explicit opportunity events and mechanical file updates

Investigation for [#845](https://github.com/schlessera/brain-kit/issues/845),
under [#838](https://github.com/schlessera/brain-kit/issues/838)'s evaluation
protocol. Source discovery used main `a5e1ecf432f8dbfb2ad1104ab436f16f1e74da59`
on 2026-10-02. The prototype is private evaluation code operating only on
factory-created disposable fixture brains. It adds no production command,
module setting, export, frontmatter field or classifier integration.

## What exists today

The interview skill asks for the opportunity, timezone-explicit date/time,
round/format and interviewer before writing. It then describes status/timeline,
contacts, pipeline, current-focus and prep updates (`## Actions`,
`packages/module-jobs/skills/interview-scheduled/SKILL.md:36-88`). These source
edits are instructions for an agent, not one implemented lifecycle transaction.
Research and preparation prose, fit assessment and the decision to pursue or
close remain conversational work (`## Actions`,
`packages/module-jobs/skills/research-opportunity/SKILL.md:32-119`).

Closing is already specified: historical relevance, no status next step or
deadline, cancellation history, and retirement of other active opportunity
deadlines (`**Closing**`,
`packages/module-jobs/skills/research-opportunity/SKILL.md:156-169`). Rebooking
keeps prior history; merely updating the status date leaves a prep deadline
stale. Existing tests of the closing skill's wording do not execute those
cross-file edits.

Directory resolution is real code: the configured opportunity type directory
takes precedence, with module `opportunitiesDir` as the null-directory fallback
(`resolveJobsCtx`, `packages/module-jobs/src/cli.ts:48-70`). The pipeline is
also real code: ensure the registry spec, then regenerate tables from child
frontmatter (`cmdPipeline`, `packages/module-jobs/src/cli.ts:525-542`;
`ensurePipelineIndex`, `packages/module-jobs/src/pipeline.ts:61-101`). There
is no reason to classify a structured event or hand-edit a pipeline row.

Briefing queries indexed deadlines over the next 60 days (`// 3. Upcoming deadlines`,
`packages/core/src/cli/commands/briefing.ts:235-250`). Markdown changes therefore
need reindexing before those queries can prove the result. `stage: closed`
alone does not remove a leftover deadline from this query.

## Event and ownership proposal

The executable private schema is
[`eventSchema`](../../scripts/evals/opportunity-lifecycle/prototype.ts).
Every event supplies a unique `id`, exact existing opportunity slug and real
calendar `on` date. It accepts the following bounded events:

| Event | Explicit input | Mechanical effect |
| --- | --- | --- |
| `scheduled` | New `roundId`, round, format, ISO instant with offset, IANA timezone, contact ID/name/role and nullable contact details | Add round/history/contact; stage interviewing; status/prep deadline and next step reflect the earliest active round; update the exact selected focus line. |
| `rebooked` | Existing active `roundId`, full replacement call details | Replace that round's current call; retain its prior event and next-step history; recompute the earliest round. |
| `cancelled` | Exact active `roundId`, reason, explicit resume stage (`researching`, `applied`, `screening`) | Retire that round. Other rounds remain; absent any, remove active deadlines/next step and the selected focus line. |
| `offer` | Nullable next step and deadline, with a deadline requiring a next step | Set offer stage, retire interview rounds and every other opportunity document deadline; retain cancellation history. |
| `closed` | Explicit reason | Set closed/historical, remove status next step/deadline and every other opportunity deadline, preserve old details and cancellation history, remove the selected focus line. |

The named timezone must agree with the supplied offset at the instant, including
DST. Missing timezone/contact, invalid/past dates, an unknown opportunity/round,
unsupported event, duplicate round, reused ID with different data or a closed
opportunity being implicitly reopened requires clarification. Missing contact
details remain explicitly unknown and never become invented outreach details.

An event ledger lives in a generated Markdown region of status, rather than in
disposable `brain.db`. It records full confirmed input. Other generated regions
hold current call details, recorded contacts and lifecycle history. Existing
prep research and status prose stay verbatim. The experiment refuses an
unowned contact table, existing interview state or existing call-details section
for scheduling until an ownership migration is reviewed; it does not attempt
to replace ambiguous prose. Closing can retire legacy deadlines while retaining
the old call details as cancelled history.

Current-focus is deliberately different: the caller supplies one complete,
existing line containing the exact opportunity wiki-link. It must occur once.
Only that line changes; unrelated priorities remain. This experiments with an
explicit text selection, not fuzzy company matching or ownership of the whole
canonical document. A production version still needs approved ownership and
migration rules, including ambiguous focus placement, disabled canonicals and
existing independently maintained prep files.

## Execution and recovery boundary

The prototype reuses the source-preserving `editFrontmatter`, generated-region
helpers, containment checks, safe file publication, pipeline spec and registry
planner/writer. It does not fall back to YAML serialization when the raw layout
cannot be edited safely. All relevant raw files are captured in the preview;
authorization is a separate supplied input, and every captured revision is
checked before the first write. Symlinked paths require clarification even
when their destination is inside the fixture.

Source writes happen before the derived pipeline. The complete status event
receipt is written last. An injected interruption returns the actual written
paths and remains incomplete. The same sealed in-memory plan can resume only
when each file still equals its before or planned-after bytes; a concurrent
edit stops recovery before another write. Replay of a completed event does no
source writes, checks deadline drift and can regenerate a failed pipeline.
An invalid registry returns `repair-pipeline`, not success.

This is **not a cross-file production transaction**. It has no shared lock,
durable recovery journal, process-crash test, production permission envelope or
git commit/rollback integration. Source files can remain partially updated
after interruption, and ordinary filesystem race windows remain. The in-memory
receipt cannot survive a process death. Production adoption requires a durable,
Markdown-authoritative recovery design, revalidation of ownership and whole
source effects, and explicit handling of registry/reindex/commit failures.
The tests establish the stated fixture controls, not unattended production safety.

## Keyless measurements

With Bun 1.3.14 and a frozen dependency install:

```sh
bun run test tests/opportunity-lifecycle-eval.test.ts
bun scripts/evals/opportunity-lifecycle/run.ts --repeat 5
```

The archived [report](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/evals/opportunity-lifecycle/keyless-report.json)
records fixture, schema, prototype and proposed-golden SHA-256 values, runtime,
repetitions, local p50/p95/min/max and throughput. Timings include planning,
source writes, pipeline generation, full keyless index rebuild and briefing;
they exclude disposable-brain setup and replay. They are local measurements,
not agent latency or a comparative speedup. No timing threshold gates CI.

The current control report was rerun on 2026-10-07 after the
[Odysseus corpus correction (#1190)](https://github.com/schlessera/brain-kit/issues/1190).
Four separate fixture setups run six events each, five times: 120 event
observations, plus replay of each event. Ithaca is the tuning entity; Pylos
uses custom taxonomy/canonical paths and existing prose prep, while Scheria uses
the module-directory fallback in held-out controls. Odysseus retains the research
and existing preparation prose; Mentor supplies the interview contact. The
reference date is `2026-07-12`. These are hypothetical lifecycle cases using
modern organisational tools, not additional events in the canonical chronology.

The earlier 2026-10-02 control report used the superseded non-UI example world.
The current report has fresh input/expected-file hashes and local timings;
historical mutation receipts below retain their original provenance. Entity
renaming preserves the four technical layouts and does not establish an
independent template holdout or comparative model quality.

Every checkpoint compares **all Markdown bytes and file membership** against
the committed [proposed expected files](../../scripts/evals/opportunity-lifecycle/expected.json).
Separate assertions query real deadline rows and the briefing section, verify
generated pipeline rows, contact deduplication, history retention and unrelated
files. The controls report zero checkpoint file mismatches, deadline/briefing
errors, unintended edits and replay writes. These goldens were seeded from
the prototype output and inspected for the intended fields and retained prose;
they still require independent review before an adoption experiment. Agreement
with them cannot establish the correctness of a subjective golden.

Thirty-three runtime tests additionally cover unknowns, missing fields,
negation/ambiguous natural language, injection-shaped input, long irrelevant
state and quoted markers, multiple rounds, duplicate events, extra prep
deadlines, legacy closure, malformed children, unsafe paths, missing ownership,
denied execution, stale previews, three interruption points and failed pipeline
recovery. No natural-language classifier exists in this harness.

Six separately restored mutations reached the intended behavioral assertions:

| Mutation | Intended assertion failure |
| --- | --- |
| Remove the propagated prep deadline | The real indexed deadline rows lack `interview-prep.md`; expected two rows, received only status. |
| Remove the authorization guard | Expected `denied`, received `applied` with actual fixture writes. |
| Remove revision validation | Expected `stale`, received `applied` after a concurrent status edit. |
| Skip closure's sibling deadline retirement | Expected no deadline rows, received `second-prep.md` with its old `2026-07-31` deadline. |
| Remove duplicate-round rejection | Expected clarification, received a new plan for an already active round. |
| Remove unowned-call/contact rejection | Expected clarification, received a plan for existing unowned call details. |

The deterministic lane makes zero inference calls, consumes no inference tokens
and incurs zero inference charges. Today's actual agent workflow has not been
run in a paid comparison. Its calls, tokens, billed/effective cost, cache behavior
and latency are unknown, so measured calls/time/money saved remain null.
No JEV mapping accuracy, thresholds, confidence calibration, model sensitivity,
generation fallback cost or measured hybrid recommendation is claimed.

## Comparative evaluation and contract requirements

Recommendation for the next experiment: keep structured event application in
code, and keep questions, research, preparation prose and ambiguous targeting
with the person/agent. Optional JEV work is confined to a proposed event and an
existing opportunity, with explicit none/unclear outcomes. It grants no write
permission, chooses no timezone and cannot bypass explicit event validation.
The [TypeSafe introduction](https://docs.typesafe.ai/introduction),
[confidence semantics](https://docs.typesafe.ai/confidence) and
[limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) were checked
on 2026-10-02; the existing D42/sync thresholds are not evidence for this task.

Before tuning, independently review the expected diffs, separate held-out
entities/templates, and freeze adoption gates: zero wrong-target edits, content
loss, permission errors, missed/stale active deadlines or duplicate entries;
all confirmed structured events either produce their complete expected effects
or an explicit incomplete/refused outcome. Ambiguous messages must abstain.
Additional coverage must include legacy ownership migration, timezone boundary
days/DST, simultaneous edits, restart recovery and arbitrary custom paths.

Record provider/account/model access and a total spend ceiling on #845 before
live runs, as #838 requires. Compare the current agent executing the existing
skills, the explicit-input deterministic lane and any optional mapping hybrid
on identical complete brains. Record full task outcomes and every model call,
input/output/cache token, retry, clarification/fallback/generation cost, billed
and effective cost, p50/p95, throughput, repetitions and spread. Verify current
model availability/pricing at that time. A live variant's missing metrics stay
unknown; no vendor example substitutes for these measurements.

If measurements support adoption, file the smallest implementation task under
#838. A possible `brain jobs event --plan/--apply` remains a proposal. It would
need a documented JSON envelope containing the event ID, outcome, changed/stale
paths, generated/reindexed result and recoverable incomplete state; explicit
revision/authorization requirements; exit semantics; stable idempotency rules;
and exact event-ledger, contact-ID, multi-round/next-step and generated-region
ownership semantics. These are additive CLI/frontmatter contract work requiring
a `CONTRACT:` commit, integration-contract documentation and a minor changeset.
Any incompatible existing-field/skill behavior also needs the maintainer's
breaking-change ruling before implementation. No MCP tool, calendar/outreach
integration, criteria settings UI or generic lifecycle seam is part of this
prototype. This investigation is not a binding production adoption decision.

## Independent preparation on 2026-10-08

The later #838 rulings already authorize canonical `claude-sonnet-5-5`, optional
`jev-1.13.0` and $15 additional billed charges for this issue within the $150
aggregate cap. API-price equivalents are diagnostics, not that cap. The present
Claude subscription hold prevents complementary input review and inference;
this preparation requests no repeated access or model permission.

The previously described uncommitted sixteen-brain preparation was absent from
the recovered tree. The newly authored `fresh-corpus.ts` has its own provenance:
sixteen complete brains, four tuning and twelve held-out, with twenty-four
checkpoints. It contains distinct round orderings, two contacts, rebooking,
last-call cancellation then closure, legacy closure, offer retirement of a
sibling deadline and unknown offer details. Eight clarification cases cover
timezone, contact, offset, round, target, duplicate focus ownership, incomplete
prior preparation and a deadline without an offer next step. These are proposed
semantic goldens authored independently of the prototype's output. Their full
reference Markdown maps use a different layout; they are not independent
semantic approval. Native output must be judged against the facts and complete
preserved prose, without requiring the prototype's private generated regions or
event ledger. The original seeded twenty-four checkpoints and 120 observations
remain separate controls, and their existing report is unchanged.

The fresh fixture factory reads the complete actual disk configuration, resolves
the enabled jobs module and module directory fallback, and captures configuration
bytes in every sealed plan. It refuses disabled modules and changed configuration
before writes. A newly exposed private-prototype limitation is corrected: after
the last call's cancellation retires the target focus row, explicit closure may
leave focus untouched only with prior event ownership and zero remaining rows
for that target. Existing or ambiguous target rows still require exact selection.
The actual source write and complete focus bytes/metadata are tested.

All twenty-four fresh checkpoints execute actual file effects. Sixteen applied
checkpoints run the source CLI's config/module resolution, pipeline regeneration,
forced index rebuild, all-deadline SQLite query and briefing, followed by exact
event replay with zero byte or metadata changes. Eight ambiguous checkpoints
produce clarification with no fixture effects. The observer covers hidden,
binary and ordinary files, modes, members, directory metadata, symlink targets
and nanosecond mtimes without following links. Only the documented disposable
root `brain.db`, WAL and SHM are excluded. No unexpected-file or same-byte-touch
exception is used. The child CLI clock is pinned to July 12; native SDK and
performance clocks remain real. Candidate timing and verification/replay timing
are recorded separately and establish no agent savings.

The installed SDK 0.3.293 and native CLI 2.1.293 execute a scripted loopback
Messages fixture in separate user, network and PID namespaces. The source and
owned dependencies are read-only; homes and brains are disposable; the launcher
inherits no credentials. Ten scripted tools use real Read/Write/Bash, including
two outside-file denials. Eleven fixture model requests have retained exact
request/response text, native stdout bytes and stderr. Actual config, pipeline,
index and briefing commands execute and expected source edits occur. The native
child closes and its stdout flushes. This uses explicit SDK `permissionMode:
default` and an exact fixture allowlist: it is a runtime/observer control, not
current-core permission policy, model quality or performance evidence.

The tee retains split UTF-8, a final frame without a newline, failed terminal
usage and stderr even when the SDK reader fails. It reads final all-model usage,
never provisional assistant output counters. Unknown auxiliary models, missing
named counters, multiple native results or forced termination cannot produce a
complete receipt; failed raw diagnostics remain available. Invoice cost is
unknown. Native stdout alone cannot establish every physical HTTP attempt. The
future live collector still needs complete actual auxiliary/request accounting;
the cache-price ambiguity tracked in #1239 must remain explicit in diagnostic
estimates.

The scored current-core baseline is blocked by #1275: omitted core permission
mode inherits native auto in the observed supported runtime, whose classifier
route and full auxiliary accounting are unresolved. A manual-mode override or
the successful scripted SDK control cannot be renamed current-core performance.
`protocol.ts` therefore keeps dispatch disabled. It declares three complete
reset repetitions, counterbalanced arms, per-checkpoint destructive/ownership
vetoes, unknown-fact clarification and full native/effects/accounting gates.
`prepare.ts` exports every new input, full proposed reference document, current
skill prompt, schema, protocol and complete source/installed-runtime closure to a
fresh owned artifact directory. Complementary exact-hash review remains required
before admission when the hold lifts. No optional natural-language mapping,
current-agent comparison, savings, production adoption or durable restart/race
safety is claimed. Signed preparation alone does not close #845.

The first new byte-only freeze is retained as superseded after independent audit:
it omitted executable/directory modes and resolved link identity. Its replacement
binds all physical files and directories, modes, device/inode identities, mtimes,
sizes and content, plus literal links constrained to the owned tree, their resolved
identities and target subtree bytes. All eighteen workspace roots/manifests and
owned installed dependencies participate; only root Git administration is excluded.
Real chmod and same-byte link retargeting change the digest, and omitting mode or
resolved-path binding fails the intended assertions. Copies need their own literal
identity freeze; a matching filename or literal symlink text is insufficient.

A later inode audit found installed dependency files still shared with external
package caches. Only this worktree's physical dependency entries were replaced
with independent byte copies, preserving modes and relative symlinks. All 59,489
regular dependency file hashes match the earlier runtime snapshot. The closure
now compares kernel link counts with every owned device/inode occurrence and
refuses files shared outside the tree before native fixture dispatch; links
entirely inside the owned tree are permitted. A real outside-hardlink fixture
and restored guard-removal mutation exercise this admission boundary.

The full reference renderer was also corrected to preserve legacy status and
existing preparation titles/frontmatter and retired header dates as history.
These proposed reference bytes changed, and receive a new semantic input hash;
they are not a transport-only amendment. Actual candidate controls now compare
complete unowned frontmatter and check retired original dates in source history.
Mutating an actual title write or dropping prior-step history fails those
specific assertions. Complementary review remains pending for the corrected
full-file expectations.
