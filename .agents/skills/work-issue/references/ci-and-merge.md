# CI and merge for the claimed issue

Read this when the implementation has a PR. Commands were checked against
installed `gh` help; use their help again if an interface changes.
Use finite queries/log exports and bounded waits, with user updates during
monitoring.

## Required local evidence

Before PR creation/readiness, execute `bun run check:pr --base origin/main`
against the relevant base and record its required commands and results.
Use `--plan` only to inspect selection. Complete runtime/browser/visual/endurance
proof remains local; automatic CI covers affected fast guarantees. Confirm local
proof matches the inspected head/base and rerun affected categories after relevant changes.
The planner's intentional skips are valid; a missing runtime, unavailable required
tool or failed local check is not. Do not turn a green fast run into a claim that
excluded suites ran. Batch intermediate pushes and keep incomplete work in draft.

## Read the actual head

Record the PR head and query live main independently. Run the comparison
blocks with shell error checking enabled; a failed comparison stops the merge
decision. PR `baseRefOid` is not a substitute for the live Git reference.

```sh
verified_head=$(rtk proxy gh pr view <pr> --repo schlessera/brain-kit \
  --json headRefOid --jq .headRefOid)
verified_base=$(rtk proxy gh api repos/schlessera/brain-kit/git/ref/heads/main \
  --jq .object.sha)
rtk proxy git fetch origin main
rtk proxy test "$(rtk proxy git rev-parse origin/main)" = "$verified_base"
rtk proxy git show --no-patch --format='%H %P %T' "$verified_base"
rtk proxy gh pr view <pr> --repo schlessera/brain-kit \
  --json state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,url
rtk proxy gh api 'repos/schlessera/brain-kit/commits/<head-sha>/check-runs' \
  --paginate --jq '.check_runs[] | {name,status,conclusion,details_url}'
rtk proxy gh api 'repos/schlessera/brain-kit/commits/<head-sha>/status' \
  --jq '{state,statuses:[.statuses[] | {context,state,target_url}]}'
rtk proxy gh pr checks <pr> --repo schlessera/brain-kit \
  --json name,state,bucket,link,workflow
```

Record `headRefOid` for this inspection and re-read it before deciding. After
a push/rebase/conflict resolution, inspect the new SHA from scratch. If CI
tests a synthetic merge commit, verify its relationship to this recorded head
and independently queried live base using the actual job checkout evidence
below. A head-only gate proves its own head checks, not the combined tree.

Read the checked-out `.github/workflows/ci.yml`, `contract.yml` and
`project-sync.yml`, plus the merge requirements, for expected checks. GitHub
Actions is the sole CI provider for main, same-repository PRs and forks under
#1320. The former Depot definitions and fork fallback copies are retired.
Forks use the ordinary read-only PR context and nonpersisted checkout
credentials; an approval-held run has not passed. Read actual GitHub checks
and logs for the current head, never an old Depot receipt or latest-main run.
GitHub checks/statuses may include additional gates. No rows,
queued/running checks or cancelled runs are not green.
Skipped/neutral checks count only where actual workflow/branch rules
intentionally exclude them; unavailable required runtimes/tests are not
passing evidence. Relevant failures need diagnosis even if `--required`
omits them.

## Inspect the active CI provider

For GitHub Actions, follow the check's run link and inspect its SHA, event,
attempt, jobs and failed steps. These commands help locate and diagnose it:

```sh
rtk proxy gh run list --repo schlessera/brain-kit --commit <head-sha> \
  --limit 100 --json databaseId,headSha,status,conclusion,workflowName,event,url
rtk proxy gh run view <run-id> --repo schlessera/brain-kit \
  --json headSha,status,conclusion,jobs,url,attempt
rtk proxy gh run view <run-id> --repo schlessera/brain-kit \
  --attempt <attempt-number> --log-failed
```

A run list alone does not establish all PR checks; use the check links for
ruleset or synthetic-merge runs omitted by the head-SHA filter.

While a workflow is still running, `gh run view --log` and `--log-failed`
refuse logs even for a completed job. Read that job's log directly instead
(`databaseId` in the run's jobs), then inspect its failing step. The installed
GitHub CLI refuses raw logs containing terminal escape sequences unless they
are explicitly allowed, even when stdout is redirected. Export those logs to
a file rather than printing the escaped response in a terminal:

```sh
rtk proxy gh api --allow-escape-sequences \
  'repos/schlessera/brain-kit/actions/jobs/<job-id>/logs' > /tmp/ci-job.log
```

Read the checkout SHA from the actual selected jobs' logs (including verification/pack
jobs); a workflow's `headSha` or PR metadata alone does not establish the tree
those jobs ran. Record the run, attempt, job IDs and checkout SHA. For GitHub's
two-parent PR merge checkout, verify immutable parents and retain its tree:

```sh
ci_checkout=<sha-from-actual-checkout-log>
rtk proxy gh api "repos/schlessera/brain-kit/git/commits/$ci_checkout" \
  --jq '{sha,parents:[.parents[].sha],tree:.tree.sha}'
rtk proxy git fetch origin "$ci_checkout"
rtk proxy git show --no-patch --format='%H %P %T' "$ci_checkout"
rtk proxy test "$(rtk proxy git show -s --format=%P "$ci_checkout")" \
  = "$verified_base $verified_head"
verified_tree=$(rtk proxy git rev-parse "$ci_checkout^{tree}")
```

The local object must agree with the immutable API receipt. Reconcile all
required jobs' checkouts with this proof; investigate different trees rather
than applying one job's receipt to the others. A changed head requires fresh
inspection. If main advanced, inspect the missing commits before refreshing:
only commits relevant to this work or its checks require a rebase and affected
revalidation. Record unrelated advancement without rebasing or restarting suites.
The earlier run still describes its recorded tree, not the newer combined tree;
retain its actual head/base, the relevance assessment and existing branch rules.
Do not overwrite the recorded base to make a comparison pass. Missing
objects/logs leave verification unfinished.

Observed example: [PR #868's CI](https://github.com/schlessera/brain-kit/actions/runs/36944640962)
checked out `a0638a549f98eb96dd2af0d991e7453bfbcb6713`, with parents old main
`5c56366e4c6918b1ed3e7a6934c2f8bb5700b224` and head
`d9c7efe3bec488549224781627796e14e032d478`; its tree was
`b7487d9b53544a8842681050b01535c5f39ba253`.
[PR #866](https://github.com/schlessera/brain-kit/pull/866) advanced main to
`b6f7d2e5f21d73ffd8975e8fd777e3b0747fdbd1` before #868 merged. #868's
matching-head squash `7a355226c9a00a1ffb8bfc20f0023e50a5c8d65b` had that newer
parent and tree `5663fe0b58f8aafbf4b6507fab9f78aa9c8df404`. The PR base field
still named old main; `--match-head-commit` pinned the head only. The older run
therefore did not prove the final combined tree. The [outcome](https://github.com/schlessera/brain-kit/issues/847#issuecomment-5943258224)
records the separate post-merge reconstruction and scoped checks without
calling them the older full CI run.

Local full verification uses `bun run check:pr --base origin/main`; its
packaging command reads the authoritative GitHub workflow. Local runs and
manual workflow dispatch do not establish automatic PR or main-push behavior.
For a cancelled GitHub run, inspect its original event, SHA and attempts before
retrying; record any recovery separately from evidence that automatic scheduling
preserves future commits. Never rerun a real test failure without diagnosis.

Identify each failing step/assertion and distinguish an issue regression
from an unrelated base failure or infrastructure problem. Fix related
code/check omissions within scope, reproduce locally where meaningful,
commit/push and inspect the new head. Fix flaky behavior instead of retrying
it away. A justified infrastructure retry names its evidence and purpose;
if the failure recurs without new evidence, diagnose or hand off. File
unrelated defects and explain their effect; they do not permit scope
expansion or bypassing a failed gate.

Read new comments/reviews between rounds. Address actionable findings and
verify affected behavior. A required unavailable review or new ruling is a
blocker; an optional review is not a reason to invent an approval step.
Never bypass required reviewers or use `--admin`.

## Merge and verify

Immediately re-read head/state/reviews/checks and query live main again.
Keep the verified head/base/tree from the passing combined-state inspection:

```sh
current_head=$(rtk proxy gh pr view <pr> --repo schlessera/brain-kit \
  --json headRefOid --jq .headRefOid)
current_base=$(rtk proxy gh api repos/schlessera/brain-kit/git/ref/heads/main \
  --jq .object.sha)
rtk proxy git fetch origin main
rtk proxy test "$(rtk proxy git rev-parse origin/main)" = "$current_base"
rtk proxy test "$current_head" = "$verified_head"
rtk proxy git diff --name-only "$verified_base" "$current_base"
```

A head mismatch requires new inspection. A base mismatch requires assessment of
the missing commits: refresh/revalidate only if they affect this work or its
checks. Record unrelated advancement and retain the original tested base/tree;
never report the earlier run as testing a different combined tree. Merge only the inspected,
passing head, a ready PR and satisfied branch rules. A completed partial
slice uses `Refs` and states remaining acceptance/verification work.

```sh
rtk proxy gh pr merge <pr> --repo schlessera/brain-kit \
  --squash --match-head-commit <verified-head-sha>
rtk proxy gh pr view <pr> --repo schlessera/brain-kit \
  --json state,mergeCommit,mergedAt,headRefOid,url
rtk proxy git fetch origin
rtk proxy git merge-base --is-ancestor <merge-commit-sha> origin/main
rtk proxy git show --no-patch --format='%H %P %T' <merge-commit-sha>
rtk proxy test "$(rtk proxy git show -s --format=%P <merge-commit-sha>)" \
  = "$verified_base"
rtk proxy test "$(rtk proxy git rev-parse <merge-commit-sha>^{tree})" \
  = "$verified_tree"
```

Avoid `--delete-branch` while a worktree/worker needs the branch. Follow a
required merge queue's accepted strategy and monitor queue checks and
**actual merge**: enqueued does not mean merged. For a queue, inspect the
actual merge-group checkout, its head/base relationships and required checks;
verify the resulting main commit against that tested combined state rather
than assuming the ordinary two-parent PR checkout proof applies. A changed
head, refused matching-head check or incompatible new base requires
refresh/revalidation,
not a weaker merge command. Protection/review/access failures are blockers,
not permission to override them.

A live-ref read cannot lock main. Even after the final read, another merge
can win the race; the final squash parent/tree checks remain required. A
mismatch means the earlier run does not establish the actual combined result.
Record the actual parent/tree and reconcile/verify that resulting state under
existing requirements; do not report the old CI as proof or push a repair to
the merged branch. Main may advance afterward: ancestry establishes presence,
while the squash's immutable parent/tree establishes what actually landed.

Confirm `MERGED`, the reported merge commit on remote main and actual issue
state. Missing merge evidence is unfinished verification, not completion.
Return to the skill's **Finish or hand off** for labels and assignment cleanup.
