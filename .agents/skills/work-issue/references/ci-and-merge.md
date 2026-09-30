# CI and merge for the claimed issue

Read this when the implementation has a PR. Commands were checked against
installed `gh`/`depot` help; use their help again if an interface changes.
Use finite queries/log exports and bounded waits, with user updates during
monitoring.

## Read the actual head

```sh
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
tests a synthetic merge commit, verify its relationship to this PR head and
current base, not an unrelated green run.

Read the checked-out `.github/workflows/`, any enabled `.depot/workflows/`
and merge requirements for expected checks and the active provider. The repo
currently uses GitHub Actions; do not require a Depot run while Depot is
disabled. GitHub checks/statuses may include additional gates. No rows,
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

When Depot is enabled, use its results and logs directly:

```sh
rtk proxy depot ci workflow list --repo schlessera/brain-kit \
  --pr <pr> --sha <head-sha> --output json -n 200
rtk proxy depot ci status <run-id> --output json
rtk proxy depot ci diagnose --run <run-id> --output json
rtk proxy depot ci logs <attempt-id> --timestamps
```

Inspect repo, PR/trigger, SHA, workflow, expected jobs and current attempts.
A `finished` workflow requires examination of job results. Prefer the known
attempt ID for failure logs; run/job shortcuts can select another attempt.
If no matching run is found, use check links/help to identify the exact run;
do not substitute latest-main CI. Missing Depot access/dispatch is a handoff
prerequisite when it prevents verification of enabled Depot checks.

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

Immediately re-read head/state/reviews/checks. Merge only the inspected,
passing head, a ready PR and satisfied branch rules. A completed partial
slice uses `Refs` and states remaining acceptance/verification work.

```sh
rtk proxy gh pr merge <pr> --repo schlessera/brain-kit \
  --squash --match-head-commit <verified-head-sha>
rtk proxy gh pr view <pr> --repo schlessera/brain-kit \
  --json state,mergeCommit,mergedAt,headRefOid,url
rtk proxy git fetch origin
rtk proxy git merge-base --is-ancestor <merge-commit-sha> origin/main
```

Avoid `--delete-branch` while a worktree/worker needs the branch. Follow a
required merge queue's accepted strategy and monitor queue checks and
**actual merge**: enqueued does not mean merged. A changed head, refused
matching-head check or incompatible new base requires refresh/revalidation,
not a weaker merge command. Protection/review/access failures are blockers,
not permission to override them.

Confirm `MERGED`, the reported merge commit on remote main and actual issue
state. Missing merge evidence is unfinished verification, not completion.
Return to the skill's **Finish or hand off** for labels and assignment cleanup.
