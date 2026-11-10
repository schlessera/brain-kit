# Landing a batch

A batch is one branch of audited commits inside one package. Hosted proof for a
test change is priced by the packages it touches, not by the number of files,
so a batch lands as **one pull request**, when it is ripe, and never one pull
request per cluster.

Land only the batch that `bun scripts/test-health.ts batch status` names in
`land`. If `land` is `null`, nothing lands this run: either no batch is ripe,
or `landingSlot.reason` says why the lane is closed.

Write `TH` for `bun scripts/test-health.ts`.

## 1. Bring the branch up to date

In the batch's worktree, on the batch branch:

```sh
git fetch origin
git merge --no-edit <batch.base>
```

Merge, never rebase: the commits carry the audit trail. On a conflict, do not
resolve it by hand. Run `git merge --abort`, find the cluster commit that
touches the conflicted file (`git log --format='%h %s' <batch.base>..HEAD -- <file>`),
[drop that cluster](#dropping-a-cluster), and merge again. Someone else changed
that test; the rotation will offer it again at its new content.

## 2. Pass the gate

```sh
TH batch verify --base <batch.base> --head HEAD
```

It must print `"ok": true`. It refuses: a change outside test code, a
proof-system change, a commit with no recorded audit behind it, a test file a
commit touched without being a member of its cluster, a new skip, retry, `only`
or long timeout, any test that disappeared without a fixed finding naming it,
and a changed Bun test file whose executed cases were never compared.

A violation is fixed by [dropping the offending cluster](#dropping-a-cluster)
or by a new, recorded commit that undoes the offending change. Never by editing
a worksheet after the fact, and never by skipping the gate.

## 3. Local preflight and the pull request

```sh
bun run check:pr --base <batch.base> > <runDir>/check-pr.log 2>&1; echo "exit $?"; tail -n 30 <runDir>/check-pr.log
sed -n '/brain-check-pr-receipt:start/,/brain-check-pr-receipt:end/p' <runDir>/check-pr.log > <runDir>/receipt.md
git push -u origin <batch.branch>
```

The second line keeps the receipt block for the pull request body. Add a
changeset only if `check:pr` asks for one.

**The batch's own issue.** File one issue for the batch before opening its
pull request, with the GitHub skill: title `<package>: test-health batch
<batch id>`, a body that names each fixed finding (file, smell, one line on
what was wrong), labels `type: test` and the package's `area:` label, and
the release milestone. The pull request closes it. Merging into `main`
needs at least one delivered issue (`--issues` in step 4), and most batches
resolve no failure issue of their own.

Then open the pull request as a draft, against the branch that `batch.base`
names:

- Title: `test(<package>): test-health batch <batch id>`.
- Body: `Closes #N` for the batch's own issue; what the batch does in numbers
  (clusters, files changed, findings fixed by lens, tests removed with their
  obligation maps, mutations killed), the gate's `stats`, `Closes #N` or
  `Refs #N` for each failure issue it resolves or advances, and the
  `check:pr` receipt block. Use the repository template. Screen the text as
  the GitHub skill requires.
- Labels: `type: test` and the package's `area:` label.

Record it: `TH record batch --batch <id> --event pr --pr <number>`.

## 4. Confirm and merge

Record every confirmation request first: `TH record batch --batch <id> --event attempt`.

**The base is `main`.** Follow the repository's ordinary path in
[CI and merge](../../work-issue/references/ci-and-merge.md), from "Reservation
before expensive confirmation" through "Merge and verify": record collisions
with `bun scripts/collisions.ts --json --pr <number>`, set the release milestone
on the pull request and on each issue it closes or advances, then
`bun scripts/integrate.ts confirm <number> --issues <owner/repo#N,...>`, listing
the batch's own issue and every issue the body closes or advances. `confirm`
checks that list and its milestones before it takes the reservation. While
main is red, `confirm` refuses; stop and leave the batch for a later run.

**The base is another branch** (an integration branch a wrapper gave you).
`integrate.ts` serves `main` only. Mark the pull request ready
(`gh pr ready <number>`), wait for that run's `proof` to pass on the current
head, then `gh pr merge <number> --squash --match-head-commit <head sha>`.
Merges into one integration branch happen one at a time.

Either way: read the result of the hosted run for the **current head**. A
missing, cancelled or skipped selected job is not green. Never rerun a failed
job.

## 5. When hosted proof fails

| The failing test | Do |
| --- | --- |
| Is a file this batch changed | [Drop its cluster](#dropping-a-cluster), push, and request confirmation once more. Do not debug it under the lane. |
| Is not in the batch, and main is red | Follow [the red-main steps](../../work-issue/references/red-main.md); resume when main is green. |
| Is not in the batch, and main is green | It is a flake outside your change. Find or file its issue, name it in the pull request, and request a fresh confirmation. The rotation will reach that test. |

If the second confirmation fails on another batch file, drop that cluster too.
After three attempts, stop: leave the pull request open, report it, and let the
next run continue.

## 6. After the merge

Verify the merge on the base, as the CI and merge reference describes. Then:

```sh
TH record batch --batch <id> --event landed --merge-sha <merge commit>
TH report --publish
git worktree remove <dir> && git push origin --delete <batch.branch>
```

Comment on each failure issue the batch advanced but did not close, saying
what remains.

## Dropping a cluster

Dropping removes one cluster's change from the batch and returns its files to
the rotation. The original commit stays in history; a revert cancels it.

```sh
git revert --no-commit <cluster commit>
git commit -m "revert: drop <runId>#<n> from the batch" -m "Test-Health: <runId>#<n>"
TH record batch --batch <id> --event dropped --commit <cluster commit> --reason "<why>"
```

The revert keeps the dropped cluster's trailer; the gate then checks that the
cluster's files are back at the base's content. If the dropped fix was real and
only its proof failed, say so in the reason: the next audit of that file starts
from it.

## Abandoning a batch

When a batch cannot land at all (its package was reorganized under it, or
conflicts touch most of its clusters):

```sh
TH record batch --batch <id> --event abandoned --reason "<why>"
```

That withdraws every audit in the batch, so all of its files are offered again.
Close the pull request if one is open and delete the branch.

## What the ledger is

Every `record` and `plan` command appends to the test-health ledger, an
append-only record on its own ref (`ledgerRef` in
`scripts/test-health/config.json`). It is how the next run knows what was
audited, what is claimed and which batches are open, and it is the only source
of the metrics. If a command reports that the ledger moved too many times, wait
a minute and run it again; nothing was recorded.
