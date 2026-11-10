# Test health: a recurring audit of the existing tests

The automated tests are kept in shape by a recurring, scripted audit rather
than by occasional clean-up epics. One skill
([test-health](../../.agents/skills/test-health/SKILL.md)) audits a few related
test files in depth per run, proves each fix, lands the fixes in per-package
batches and records what it did. A second skill
([test-health-push](../../.agents/skills/test-health-push/SKILL.md)) runs the
same audit over the whole suite at once. This record covers the rulings the
maintainer made on 2026-11-10 while the two were designed, the alternatives
that were rejected, and the measurements behind them.

The authoring rules the audit checks against are in
[test-authoring.md](../process/test-authoring.md). The earlier one-off work it
follows is in [ci-utility.md](ci-utility.md) and
[experiment-tier.md](experiment-tier.md).

## Decision

- **Improvement is statistical, and nobody reviews the changes by reading
  them.** The maintainer does not intend to read these pull requests. Review is
  therefore mechanical and happens before a change is recorded: a fixed finding
  must carry the evidence its action requires (a killed mutation, an obligation
  map, repeated clean runs, a measured speed-up), and a batch must pass a gate
  that refuses anything a reviewer would refuse on sight. The outcome is
  watched through metrics, not through individual diffs.
- **Depth per run, coverage through repetition.** A run audits a handful of
  clusters through every lens instead of skimming many files. The whole suite
  is reached because the selection varies per run and is systematic: a
  worst-first queue and an oldest-audit-first queue alternate, and a file
  edited after its audit becomes eligible again. The set of tests is a moving
  target, so nothing keeps a list of them; the audit unit is discovered from
  the same inventory CI uses.
- **Scripts decide what can be decided; the agent supplies judgment.** What to
  audit, the static signals, repeated-run behaviour, mutation verdicts, the
  worksheet's validity, the batch gate and every metric are computed by
  `scripts/test-health.ts`, so a cheaper model and a stronger one produce
  comparable records. The agent's own contribution is recorded only in
  enumerated fields.
- **A batch stays inside one package and lands as one pull request.** Hosted
  proof for a test edit is priced by the workspaces it touches, not by the
  number of files (`const packageCode`, `scripts/ci-plan.ts:355-356`): any path
  under a package's `tests/` selects that package and its reverse dependants.
  One changed test in a package costs the same confirmation as thirty, so
  small pull requests are the most expensive way to land this work.
- **The ledger lives on its own ref.** What was audited, claimed, batched and
  landed is an append-only record on `refs/heads/brain-test-health`. It is the
  rotation's memory and the only source of the metrics. A progress log does not
  belong in a document in the tree, and a run must be able to record itself
  without landing a pull request. The write is the compare-and-swap push that
  the integration reservation already uses
  (`export class GitReservationStore`, `scripts/integration-reservation.ts:103-146`).
- **Test-health landings may take lane capacity from product work for now.**
  Brittle and slow tests were the larger bottleneck at the time of the ruling.
  The cadence and the landing caps are configuration
  (`scripts/test-health/config.json`), to be lowered once the suite has
  settled.
- **The tooling's own tests never gate the product.** The tests of the skill
  scripts live in `scripts/skill-tests/`, outside product discovery, pull
  request proof and the release's experiment tier, and run with
  `bun run test:skills`. Root `tests/` accompanies every package change's unit
  proof, so tooling tests placed there would have made a broken audit tool
  block product work. The audit runs its own tier first and stops only itself
  when that is red.
- **The full pass is a wrapper that adds only scale.** A dedicated push shards
  the suite, runs the ordinary audit in parallel against an integration branch
  and lands it once. It changes the base, the concurrency and when a batch is
  ripe, through a configuration profile, and nothing about how a test is
  audited, so the approach is tuned in one place.

## What the gate refuses

Because the gate stands in for review, its refusals are part of the decision:

- a change outside test code (a product defect is filed, not fixed here);
- a proof-system change, including any changed timeout or deadline, which keeps
  its own lane ([the proof-system lane](ci-utility.md#proof-system-lane));
- a commit with no recorded audit behind it, or one that touches a test file
  outside its cluster;
- a new skip, retry, focused test or long time budget;
- any test that disappears without a fixed finding naming it. Declarations
  are compared by title from git, and one declared removal accounts for one
  disappearance, so a legitimate removal cannot cover for an accidental one.
  For Bun test files the executed case count is compared too, and may fall only
  by the declared number: that catches a shortened table or a test that is no
  longer collected, which the source alone does not show. A removal that is
  declared still needs its obligation map and a killed mutation on the test
  that keeps the assertion.

## Alternatives rejected

- **One pull request per audited cluster.** It would have asked for roughly
  twenty confirmations a week from a lane that every product change shares,
  each paying a full affected-package proof.
- **Relying on the leaf-test shortcut.** CI runs only the changed files when
  every changed file is an independent Bun test. By an approximate count on
  2026-11-10 about 15% of test files qualified, because the cost table and the
  documentation name most of the others. The design does not depend on it.
- **Keeping the rotation's state in the main tree.** Every run would have
  needed a pull request to record itself, and the tree would have gained a
  progress log.
- **Human review of each batch.** It would cap the work at the maintainer's
  reading time; the ruling is that the proof requirements and the metrics carry
  that weight instead.
- **Fixing timeouts, shard layout or selection from the audit.** Those changes
  stay in the proof-system lane with its off-main qualification.

## Measurements on 2026-11-10

Taken at `3aadc8df51294fc32fc14cd3b5552de4d52193fc`, to size the design. They
are a snapshot, not a baseline for any later claim.

| Measure | Value |
| --- | --- |
| Test files in product proof and the experiment tier | 1,832 |
| Unit cost table: files, and seconds for one pass | 1,179 files, 4,354 s |
| Share of that time in the 50 slowest files | 62% |
| Files costing 120 s or more | 5 |
| Open `type: test` issues, and those marked `needs: repro` | 80, of which 23 |
| Scanner leads: weak matchers; sleep-shaped call sites; conditional skips | 1,295; 886; 136 |
| Merges to `main` in the preceding 15 days | 259, typically 10 to 25 a day |
| Median and 90th-percentile time from opening a pull request to its merge | 2.0 h and 14.6 h |

Scanner leads are places to look, not defects: a weak matcher is sometimes the
whole claim, and a sleep-shaped call is sometimes a failure cap.

## Things to know before changing it

- The smell catalogue (`scripts/test-health/catalog.ts`) is the vocabulary of
  the scanner, the worksheet, the metrics, the skill's references and the
  authoring guide. A new smell is added there first.
- A threshold belongs in `scripts/test-health/config.json`, not in a skill.
- The audit never widens a batch beyond one package, and the wrapper never
  carries audit guidance of its own. Both are tested.
