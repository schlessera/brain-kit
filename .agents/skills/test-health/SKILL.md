---
name: test-health
description: Audit a batch of brain-kit's automated tests in depth and fix the worst of them - tests that cannot fail, overlap between tiers, non-determinism, open failure issues, slow tests, tests that do not run, wrong tiers and poor hygiene - with scripted selection, proof and metrics. Use for a recurring test-health run, or when asked to audit or improve the existing tests; not for writing tests for a feature, and not for fixing a red main.
---

# Keep the tests healthy

One invocation is **one run**. A run audits a few clusters of related tests
inside one package, commits each proven fix to that package's batch branch,
lands the batch when it is ripe, and records what it did. Coverage of the whole
suite comes from running this again and again: the planner picks different
files every time and reaches all of them eventually.

`scripts/test-health.ts` decides everything that can be decided mechanically:
what to audit, what the static signals are, how a test behaves over repeated
runs, whether a mutation is killed, whether your worksheet may be recorded and
whether a batch may land. You supply the judgment in between. **Nobody reads
these changes before they merge.** The worksheet's evidence and the batch gate
are the review, so never work around them, and when you are unsure, do not
change the test.

A run request authorizes: changes to test code, commits and pushes to
`test-health/*` branches, one pull request per batch and its merge through the
repository's normal path, issue filing and comments under the GitHub skill, and
writes to the test-health ledger. It does not authorize anything in
[the rules that do not bend](#rules-that-do-not-bend).

Read [the authoring guide](../../../docs/process/test-authoring.md) first: it is
what you audit against. Use [the GitHub skill](../github/SKILL.md) for every
issue you file or comment on.

## The run

Write `TH` for `bun scripts/test-health.ts`. Pass the caller's `--profile`,
`--base`, `--shard` and `--batch` to `plan` if you were given them; otherwise
pass none. Read [spending few tokens](#spending-few-tokens) once before you
start: a run reads a great deal, and most of it can be avoided.

1. **Preflight.** `bun run test:skills > /tmp/test-skills.log 2>&1; echo "exit $?"`,
   then `TH doctor`.
   - The tooling's own tests fail: stop, and report the failing lines of the
     log. Do not audit with a broken tool. This tier gates only this skill; it
     is not product proof and blocks nothing else.
   - `ok: false`: stop and report the failed check.
   - `capabilities.browserRunner: false`: add `--bun-only` to `plan`.
   - `capabilities.mayLand: false`: audit, but skip step 6.
2. **Plan.** `TH plan`. It claims the files it gives you. Note `runId`,
   `runDir`, `package`, `batch` and `clusters`.
   - `throttled` is set: too much is waiting to land. Go to step 6, then record
     the run with `--outcome throttled`.
   - `clusters` is empty: go to step 6, then record `--outcome nothing-to-do`.
3. **Check out the batch branch in its own worktree**, and run everything else
   from there.

   ```sh
   git fetch origin
   # batch.isNew is true:
   git worktree add <dir> -b <batch.branch> <batch.base>
   # batch.isNew is false:
   git worktree add <dir> <batch.branch> && git -C <dir> merge --no-edit <batch.base>
   cd <dir> && bun install --frozen-lockfile && bun run build
   ```

   Browser and layout files load the built packages. In a worktree without
   the build they fail before collecting a test, and `measure` reports them
   `not-collected`.

4. **Audit each cluster, in order.** Stop taking new clusters when the time
   budget you were given is spent (45 minutes if none was given). A cluster you
   did not finish is simply not recorded; its claim expires.

   1. `TH brief --run <runId> --cluster <n>` (Markdown). Read every member
      file completely, and the source it exercises. Read context files only to
      judge overlap.
   2. Baseline, one command per runner (`bun` files together, `visual` files
      together): `TH measure <files> --shuffle --together --out <runDir>/baseline-<n>.json`.
      Browser files take minutes per run; give them `--runs 2` and no `--shuffle`.
   3. Walk the eight lenses in the order of the table below, one reference at a
      time. Give every member a verdict for every lens and write a finding for
      each problem.
   4. Decide each finding with [the decision table](#deciding-a-finding), then
      fix and prove the ones you fix. The reference says which proof.
   5. If you changed any file, measure the changed files again:
      `TH measure <changed files> --out <runDir>/after-<n>.json`. The baseline
      and this file are how the recorder proves no test was lost.
   6. Write the worksheet to `<runDir>/cluster-<n>.json`
      ([format](references/worksheet.md)) and run
      `TH validate <runDir>/cluster-<n>.json --run <runId>` until it is `ok`.
      A problem it reports is a missing proof, not a formatting chore.
   7. If you changed anything, commit exactly this cluster's files, with the
      trailer from the brief as the last line of the message:

      ```sh
      git add <changed test files>
      git commit -m "test(<package>): <what the cluster's fixes do>" -m "Test-Health: <runId>#<n>"
      ```

   8. `TH record cluster --run <runId> --cluster <n> --worksheet <runDir>/cluster-<n>.json`,
      adding `--commit HEAD` when you committed.

5. **Push** the batch branch: `git push -u origin <batch.branch>`. Do not open
   a pull request here.
6. **Land a ripe batch.** `TH batch status`. If `land` names a batch, follow
   [landing](references/landing.md) for that batch. Otherwise nothing lands
   this run.
7. **Record the run**: `TH record run --run <runId> --outcome completed --agent <your model name>`,
   then `TH report --publish`.
8. **Feed the guide.** If this run fixed the same smell three or more times,
   read that smell's rule in the authoring guide. If the rule would not have
   prevented what you saw, sharpen it or add the example, in the batch. If the
   smell is mechanical, file an issue proposing a lint check.
9. Report in a few lines: package, clusters audited, findings by status, what
   landed, and anything a human must decide.

| Order | Lens | Reference |
| --- | --- | --- |
| 1 | `cannot-fail` | [cannot-fail.md](references/cannot-fail.md) |
| 2 | `overlap` | [overlap.md](references/overlap.md) |
| 3 | `nondeterminism` | [nondeterminism.md](references/nondeterminism.md) |
| 4 | `failure-issues` | [failure-issues.md](references/failure-issues.md) |
| 5 | `cost` | [cost.md](references/cost.md) |
| 6 | `not-running` | [running-tier-hygiene.md](references/running-tier-hygiene.md) |
| 7 | `tier-and-doubles` | [running-tier-hygiene.md](references/running-tier-hygiene.md) |
| 8 | `hygiene` | [running-tier-hygiene.md](references/running-tier-hygiene.md) |

## Deciding a finding

A scanner signal is a lead. It becomes a finding only when you have read the
test and agree something is wrong.

| What you found | Action | Status |
| --- | --- | --- |
| The signal is fine in context (the weak matcher is the whole claim, the timer is a failure cap) | `none` | `accepted`, with the reason in the note |
| You can fix it inside this cluster's member files, and can produce the proof the reference names | the fixing action | `fixed` |
| The fix needs product code, a timeout or deadline, shard or selection rules, a workflow, or a test file outside this cluster | `file-issue` | `filed`, with the issue number |
| The file is context (another package), or you ran out of budget, or the proof would not come out | the action you would take | `deferred` |
| An open issue on the file is assigned to someone | comment your evidence on the issue | `deferred` |

When two actions fit, take the smaller one. Strengthening an assertion beats
rewriting a test; rewriting beats removing it.

## Rules that do not bend

- **Test code only.** A product defect is filed as a `type: fix` issue and the
  finding is `filed`. The batch gate refuses any other path.
- **Never hide a test.** No `skip`, `todo`, `only`, `retry` or conditional
  skip, and no raised or added timeout or deadline. The gate refuses each.
- **Never weaken an assertion to get green**, and never delete a test because
  it fails.
- **Take assertions away only with an obligation map**: every assertion of the
  removed, merged or moved test mapped to the test that still makes it, plus a
  killed mutation on that retained owner.
- **No test disappears unannounced.** Every test title that is gone after your
  change must be named in a fixed finding, as a removal or as a rename, and a
  file's count of executed cases may fall only by the number you declared. The
  recorder and the batch gate both check it, by name and by count, so a test
  dropped by accident stops the cluster instead of landing.
- **A test that fails in your baseline is not yours to "fix" by editing its
  expectation.** Find out whether the test or the product is wrong
  ([failure issues](references/failure-issues.md)).
- **Leave no mutation behind.** `TH mutate` reverts its own; run
  `git status --short` before each commit and commit only test files.
- **Stay inside your cluster.** Member files only. A helper shared with other
  tests is changed only when every user of it is a member.
- **Never rerun a failed CI job**, and never raise a deadline to absorb load.
- **Fixtures use the Odysseus world** and the pinned date `2026-07-12`; no real
  names anywhere.

## Spending few tokens

- **Every `TH` command prints one line of JSON** with what the next step needs,
  and writes the detail to a file. Do not print those files: `validate` and
  `record` read the receipts and measurements themselves. Add `--full` only
  when the one line leaves a question open.
- **The brief replaces searching.** It gives the signal lines, costs, issues
  and neighbours for a cluster; do not rerun `signals` or grep for what it
  already lists.
- **Read each member file once**, whole. Re-read only the lines you changed.
- **Send long output to a file** and read its end:

  ```sh
  bun install --frozen-lockfile > <runDir>/install.log 2>&1; echo "exit $?"; tail -n 5 <runDir>/install.log
  ```

- **Write git, gh and test commands plainly.** Where `rtk` is installed, its
  hook compresses their output without being asked. Never prefix a command
  with `rtk proxy` or `rtk bypass`: both switch the compression off.
- **Do not pipe `gh` JSON through `jq` in the shell.** `TH plan`, `TH brief`
  and `TH batch status` already fetch and reduce what a run needs from GitHub.

## Commands

```sh
TH doctor
TH plan [--profile cron|push] [--base <ref>] [--package <name>] [--shard <file>] [--batch <id>] [--bun-only] [--dry-run]
TH brief --run <runId> --cluster <n> [--json]
TH signals <file...>
TH measure <file...> [--runs <n>] [--shuffle] [--together] [--stress] --out <file>
TH mutate --test <file> [--name "<case>"] --expect "<failure text>" --from-worktree <path...> --out <file>
TH validate <worksheet> --run <runId>
TH record cluster --run <runId> --cluster <n> --worksheet <file> [--commit <sha>]
TH record run --run <runId> --outcome completed|throttled|blocked|nothing-to-do|failed --agent <label>
TH record batch --batch <id> --event pr|attempt|dropped|landed|abandoned [--pr <n>] [--commit <sha>] [--merge-sha <sha>] [--reason "<text>"]
TH batch status
TH batch verify --base <ref> [--head <ref>]
TH report [--publish]
```

Tunable values (cluster size, files per run, when a batch is ripe, how many
may land per day) live in `scripts/test-health/config.json`, not here.

When a command, limit or path in this skill turns out wrong, fix it in the
batch that found it.
