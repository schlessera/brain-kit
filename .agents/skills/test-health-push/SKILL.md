---
name: test-health-push
description: Run one dedicated push that takes the whole brain-kit test suite through the test-health audit in parallel and lands the result as a single pull request from an integration branch. Use only when explicitly asked for a full test-health pass or push; the recurring run is the test-health skill, and this skill adds nothing to how a test is audited.
disable-model-invocation: true
---

# One full pass of the test suite

This skill is **only about scale**. How a cluster is chosen, audited, proven,
recorded, gated and landed is [the test-health skill](../test-health/SKILL.md)
and its scripts, unchanged. When the approach is tuned, it is tuned there, and
this skill inherits it. If you find yourself writing an instruction here about
what makes a test good or bad, it belongs in the other skill.

What this adds: one integration branch as the base, disjoint shards so many
workers can run at once, an integrator that merges their batches, a shake-out
of the combined result, and one landing on `main`.

A push request authorizes everything a test-health run authorizes, plus
creating the integration branch and its epic issue, starting the workers, and
the final merge to `main`. Loading this skill does not start a push.

Write `TH` for `bun scripts/test-health.ts`.

## Before starting

- `TH doctor` is `ok` and `capabilities.mayLand` is true.
- The regular skill has already landed at least one batch on `main` through its
  own path. A push repeats whatever the regular run does several hundred
  times; a flaw in it is repeated as often.
- You were given, or have chosen and stated: a cut-off time, and the number of
  workers. Local test runs are the bottleneck, and heavy ones queue behind host
  admission, so more workers than half the machine's CPUs only wait.

## 1. The epic and its branch

File one epic issue for the push with the GitHub skill: the outcome (every test
file audited once at its current content, fixes landed as one pull request),
the cut-off, and that what is unfinished at the cut-off returns to the
recurring run. Then create the branch from current `main`:

```sh
git fetch origin
git push origin origin/main:refs/heads/epic/<epic number>-test-health
```

Call it `EPIC` below: `origin/epic/<epic number>-test-health`.

## 2. Shards

```sh
TH shards --profile push --base EPIC --count <workers x 2> --tag e<epic number> --out <shard dir>
```

Each shard is a list of files inside one group, weighted by cost, so every
group with work gets at least one and the count is a target. A group is a large
package, or `small`: the packages with few test files share shards and batches
rather than each opening a pull request of its own. Shards are
disjoint by construction, and the ledger's claims keep two workers on one shard
from colliding.

## 3. Workers

Start one worker per shard, at most the chosen number at a time, each in its
own worktree. A worker's whole brief is:

> Use the `test-health` skill. Pass `--profile push --base EPIC --shard <shard file>`
> to every `plan`, and add `--bun-only` if `doctor` reports no browser runner.
> Repeat runs until `plan` returns no clusters or the cut-off passes. Then land
> your batch as the skill's landing reference describes for a base that is not
> `main`, and report its pull request number, head and state.

Do not give a worker any audit guidance of your own. The `push` profile in
`scripts/test-health/config.json` already changes what scale requires: no file
budget per run, longer claims, and a batch that is ripe only when its group
has nothing left to audit.

When a worker finishes, start the next shard. A worker that stops early leaves
its claims to expire; start its shard again and the new worker continues the
same batch.

## 4. Integrating

One integrator, which is you, merges the workers' pull requests into `EPIC`,
**one at a time**, each only after its own hosted proof passed on its current
head, exactly as the landing reference says. After each merge, the open worker
branches merge `EPIC` in before their next confirmation.

Record each as the landing reference says (`--event landed`). A worker whose
batch cannot land abandons it (`--event abandoned`); its files return to the
recurring run.

## 5. Shake-out

When the last batch is merged or the cut-off has passed, run the exhaustive
proof on the combined branch, twice, without holding the main lane:

```sh
gh workflow run ci.yml --ref epic/<epic number>-test-health
```

For every test that fails in either run and whose file a batch changed:
restore that cluster's member files from `main` on the epic branch, commit, and
withdraw its audit, so the recurring run takes it up again:

```sh
git checkout origin/main -- <the cluster's member files>
git commit -m "revert: drop <runId>#<n> after the shake-out" -m "Test-Health: <runId>#<n>"
TH record void --run <runId> --cluster <n> --reason "<the failure>"
```

A failure in a file no batch changed is an existing flake: find or file its
issue and carry on. Repeat the exhaustive run after any drop, until two
consecutive runs agree.

## 6. One landing on main

```sh
git fetch origin && git merge --no-edit origin/main      # on the epic branch; a merge commit
TH batch verify --base origin/main --head HEAD --net-only
bun run check:pr --base origin/main
```

`--net-only` checks the whole diff (test code only, no proof-system change, no
new skip or retry, no test removed without its recorded obligation map) and
skips the per-commit trail, which each batch already passed before it was
squashed into `EPIC`.

Open one pull request from the epic branch to `main`, with the push's numbers
from `TH report` and the two shake-out run links as its off-main evidence. Land
it under the main reservation as a **merge commit**, so each batch stays one
revertable commit: acquire and renew the lease, mark the pull request ready,
wait for that run's `proof`, merge with `gh pr merge --merge --match-head-commit`,
and release the lease. The reservation commands are in
[CI and merge](../work-issue/references/ci-and-merge.md), "Reservation before
expensive confirmation"; do not use `integrate.ts confirm` here, because it
squashes.

## 7. Afterwards

- `TH report --publish`, and put its coverage and landing figures on the epic.
- For a before-and-after of the suite's cost, compare the last nightly
  exhaustive run before the push with the shake-out runs, using
  `bun scripts/ci-timings.ts collect --run <run id>`. They differ only by the
  push's test changes, which is as close to a controlled comparison as hosted
  runs get; say so, and do not claim more.
- Close the epic when its pull request has merged and main's own run is green.
  The recurring run continues from the ledger: everything audited here is
  already marked, so it picks up only new, changed, dropped and unfinished
  files.

## When to stop early

- Main turns red: workers keep auditing, nothing merges to `main`, and step 6
  waits.
- The first two worker batches both fail their gate or their proof for the same
  reason: stop the push. That is a flaw in the regular skill; fix it there and
  start again.
