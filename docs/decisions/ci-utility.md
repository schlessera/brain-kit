# CI guarantees per runner-minute

The maintainer selected this policy on 2026-10-08 under
[#1305](https://github.com/schlessera/brain-kit/issues/1305): keep only fast,
important automatic checks, make them conditional on affected inputs, and move
expensive checks into mandatory local proof before creating a PR. No test or
guarantee is removed. This execution policy supersedes earlier records'
requirements to run complete browser/runtime suites on every automatic PR run;
their isolation, image pins, fixtures and behavioral assertions remain binding.

## The unit being optimized

Parallel job elapsed time hides consumption. A sample of 198 terminal CI
workflows used about 14,514 summed attempt-minutes in roughly 23 hours. Successful
workflows cost a median 93 runner-minutes despite finishing in 21 wall-clock
minutes. Cancelled workflows consumed 43%; tests, browser checks and layout
checks consumed 89%. These are a dated sample, not a monthly forecast or invoice.

Automatic CI therefore runs cheap metadata/lint gates, strict typechecking and
explicit fast contract/data-integrity/permission tests, plus one conditional
packed-consumer job. Strict types and two cost-balanced fast-test batches
share a queue on one runner, with at most two active processes. A freed slot
starts the next batch; every selected file runs once. Ordinary Bun processes
preserve the existing registry/preload behavior. Native parallel workers are
another option only after current-version runtime/guard and cost validation;
older comments about isolation are not a permanent ruling against parallelism.
Draft PRs run only the cheap gates. Main pushes retain integrated commit
verification. Superseded PR work remains cancellable.

After cheap selection/lint/metadata gates, the longer conditional packaging job
runs before fast verification. Verification depends on packaging success, or an
intentional packaging skip when the planner selected no shipped changes. Failed,
cancelled or unexpectedly skipped packaging does not launch verification. The
short compiler/test tasks still share their two-process queue once that job
starts. Cancelling during packaging therefore avoids spending any minutes on
the downstream verification runner; completed upfront gates still cost time.
This trades longer feedback on completed runs for less speculative work on
superseded heads. Cheap gates stay first because they can reject a contribution
before either runtime job starts. The independent title/label contract workflow
stays separate so metadata edits cannot rerun packaging.

Both providers support job dependencies. The [status-function rule](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)
requires an explicit cancellation check when continuing after an intentionally
skipped prerequisite; relying on the default `success()` would skip verification
for tests-only changes. [Depot supports the same expressions](https://depot.dev/docs/ci/compatibility).

Check selection uses the actual git diff and reverse workspace dependencies,
including peers, optional and development dependencies. Renames include both
owners; deleted/unknown packages and global tooling/dependency changes expand
selection conservatively. An unreadable diff fails instead of skipping checks.
Fork workflows preserve the same affected conditions and gates through generated
adapters. An intentional conditional skip is distinct from an unavailable check.

## Full proof remains local

Before creating or marking a PR ready, run `bun run check:pr --base origin/main`.
Its planner includes committed, staged, unstaged and untracked changes. Code and
tooling changes run the complete default unit/integration/runtime suite. Affected
UI work also runs every pinned browser project and every layout/offline/endurance
test. Capture inputs require editorial provenance/reproducibility verification.
Relevant runtime work keeps the production Claude probes and shared-process
cleanup control, plus native delegation, capability and Haiku probes with their
measurement-isolation tests; real Chrome and permitted offline namespaces are
prerequisites.
Shipped changes retain the complete packed consumer checks. Logs and artifacts
remain available locally, and the PR records commands, outcomes and head/base.

Existing test files, discovery, browser permutations, real deadlines and
measurement scripts remain intact. A shorter automatic list does not establish
the guarantees of excluded tests. Missing prerequisites, skips and failed local
checks leave verification unfinished. Revalidate affected proof when code,
dependencies, harness or a relevant base changes. Inspect missing main commits
before refreshing; unrelated advancement is recorded without rebasing or
restarting suites. Retain actual tested head/base and existing branch rules.
A green automatic run cannot replace
that proof.

## Alternatives

More shards shorten feedback but duplicate setup and do not remove work. Larger
runners charge more and cannot shorten a real ten-minute recording boundary.
Dependency installs took only a few seconds in the inspected run; caching them
does not address the dominant cost. Dropping tests entirely loses guarantees.
Keeping automatic exhaustive UI matrices spends minutes on unrelated changes.
The selected policy preserves those assertions while moving execution to the
checkout where the PR is prepared.

## Measurement and upstream guidance

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
