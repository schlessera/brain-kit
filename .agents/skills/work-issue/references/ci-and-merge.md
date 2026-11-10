# CI and merge for the claimed issue

Read this when the implementation has a PR. Commands were checked against
installed `gh` help; use their help again if an interface changes.
Use finite queries/log exports and bounded waits, with user updates during
monitoring. Write commands plainly: where `rtk` is installed, its hook
compresses their output without being asked, and a `rtk proxy` or `rtk bypass`
prefix switches that off. `bun scripts/pr-status.ts <pr>` reads a pull
request's head, live base, checks, `proof` and failures in one line of JSON;
the raw `gh` commands below are what it reads, for when you need more than it
prints. The CI policy these commands check is
[docs/process/testing.md](../../../../docs/process/testing.md#required-proof-for-a-pr).

Green is a claim about a SHA, not about `main`. A commit pushed to a branch
after its PR merged never reaches `main`: CI never runs on it, and `gh pr
checks` keeps reporting the old green run. After a rebase, a green summary can
belong to the pre-rebase commit. Read the checks for the current head; no rows
means CI has not started on that commit, which is not the same as green.

## Required evidence

Before opening/marking ready, execute `bun run check:pr --base origin/main`
(`--base <parent-ref>` for an upper stack layer) for focused preflight.
Default preflight runs lint/leakage, environment documentation, changeset checks
and affected fast invariants, including working-tree changes. Import-graph
feedback is skipped by default; add `--import-graph` for offline-wrapped
`--changed=<merge-base-sha>` feedback. `--plan` lists the selected commands and
arguments, including contribution changeset validation, and explains the skip
and enabling flag. An empty import-graph selection prints Bun’s no-affected-tests reason and
succeeds. This misses spawned commands and file-read/string-named inputs;
it does not replace complete affected hosted discovery. Full/all modes retain
their existing suites without adding this feedback step.
The queue seeds Bun from reviewed hosted weights. Timing refreshes use the
[explicit attributed command](../../../../docs/process/ci-timings.md#refresh-reviewed-unit-weights);
local wall times remain comparison evidence.
Record actual behavioral failing-first/restored mutation
receipts and visual judgment. Complete repeatable proof runs in selected hosted
jobs under #1326, including full affected discovery, pinned browser/layout/
endurance/editorial and native runtime categories. Optional `--full` and `--all`
retain complete local commands. Every selected hosted job must pass; missing
runtimes, failures/cancellations and unexpected skips leave proof unfinished.
Keep drafts cheap and batch pushes. Ready synchronize runs fast feedback and
leaves `proof` nonpassing; convert to draft and mark ready after the final push
to request candidate confirmation. Open/reopen ready events also request it.
For heavy iteration on a draft, run `bun scripts/request-heavy-feedback.ts
<pr>` (`--json` prints the run identity). It dispatches the PR's affected heavy
categories at its live head without the reservation, and refuses a ready,
closed, foreign or moved head. A newer request or push cancels the earlier run,
and admission waits while a ready confirmation holds the reservation. Its
aggregate, `draft heavy feedback`, is feedback only: the merge gate never reads
it, and exact-head ready confirmation remains the only `proof`. Use long local
suites only to debug a specific failure.
Draft runs report `draft gates`, not `proof`. A ready PR without a passing
`proof` from its confirmation run is unconfirmed, even if `draft gates` passed
or failed because its live read found the PR ready; request confirmation again.
The candidate gate checks actual merge parents/tree against the live head/base.
A changed base requires a fresh confirmation event even without a rebase;
valid immutable browser/layout retention remains available. Read the actual
`refs/pull/<number>/merge` commit too: GitHub can retain its old base across a
draft/ready transition. When that ref still has old parents, refresh the branch
against live main before requesting confirmation; another same-head event alone
does not establish a new combined tree. Endurance is fresh
and separately mandatory whenever selected. Assess relevant base changes before redoing
heavy work; a new base requires confirmation, with valid browser/layout retention avoiding unnecessary execution.
Under #1333, a selected browser/layout domain may intentionally skip fresh
execution after complete input equivalence and original successful run/attempt/
job/check/checkout receipts are validated. Inspect the current retention ledger
and independently validating aggregate. Preserve original identities; do not
describe retained jobs as executions on the new SHA. Native/Git-dependent and
unknown domains, main pushes and scheduled/manual coverage remain fresh.

A draft-to-ready transition can retain GitHub's previous PR base and synthetic
merge ref even after live main advances. Before requesting expensive confirmation,
read the REST pull request's `base.sha` and fetch `refs/pull/<pr>/merge`; verify
its immutable parents against the independently queried live base and current
head. If those still describe the old base, keep the PR draft and refresh the
branch onto the verified live base, preserving source receipts where their
inputs are unchanged. Rerun focused preflight, push, and verify the refreshed
merge parents before marking ready. A new event alone does not establish a
fresh candidate; selected job checkout and aggregate checks remain required.

## Read the actual head

For stacked PRs, apply [Stacked PR evidence](#stacked-pr-evidence) below;
the `main` commands in this reference describe an ordinary PR or bottom layer.

Record the PR head and query live main independently. Run the comparison
blocks with shell error checking enabled; a failed comparison stops the merge
decision. PR `baseRefOid` is not a substitute for the live Git reference.

```sh
bun scripts/pr-status.ts <pr>
git fetch origin main
git show --no-patch --format='%H %P %T' <liveBase>
```

Take `verified_head` from `head` and `verified_base` from `liveBase`: the
script queries the base branch's live Git ref itself, independently of the
pull request's own base field. `mergeRef.current` says whether GitHub's
synthetic merge commit has exactly that base and that head as its parents;
`false` is the stale-base case described below. `checks.total` of zero means
CI has not started on this head, which is not green; `proof` is `passed` only
for a successful `proof` check on this head; `receipt` says whether the body
carries a `check:pr` receipt. When you need a single check's details, the
underlying reads are `gh pr view <pr> --json statusCheckRollup` and
`gh api 'repos/schlessera/brain-kit/commits/<head-sha>/check-runs'`.

Record `headRefOid` for this inspection and re-read it before deciding. After
a push/rebase/conflict resolution, inspect the new SHA from scratch. If CI
tests a synthetic merge commit, verify its relationship to this recorded head
and independently queried live base using the actual job checkout evidence
below. A head-only gate proves its own head checks, not the combined tree.

A fresh ready event can still carry GitHub's cached `pull_request.base.sha`.
Compare the metadata job's `BASE_SHA` with the actual checkout's first parent,
as well as the live base; checking only the checkout against live main misses
this mismatch. If the requested base is stale, merge fetched `origin/main`
into the issue branch, run the required preflight, push while draft and request
confirmation again. Verify the refreshed metadata before spending the rest of
the run. Do not weaken the candidate identity gate or call the earlier tests
proof of a differently requested candidate.

Read the checked-out `.github/workflows/ci.yml`, `contract.yml` and
`project-sync.yml`, plus the merge requirements, for expected checks. GitHub
Actions is the sole CI provider for main, same-repository PRs and forks under
#1320. The former Depot definitions and fork fallback copies are retired.
Forks use ordinary `pull_request` with a read-only token (`contents: read`,
plus `actions: read` / `checks: read` for bounded proof lookup), no secrets
and nonpersisted checkout credentials; an approval-held run has not passed.
Drafts run cheap gates only, and tests-only changes may intentionally skip
packaging while complete affected tests run. Read actual GitHub checks
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
bun scripts/pr-status.ts <pr> --failures --logs <dir>
gh run view <run-id> --repo schlessera/brain-kit --json headSha,status,conclusion,jobs,url,attempt
gh run view <run-id> --repo schlessera/brain-kit --attempt <attempt-number> --log-failed
```

The first command names every failed job of the head's runs with its failed
steps, saves each job's log under `<dir>` and prints only its failing lines;
read the saved log when those lines are not enough. `runs` in the plain
`pr-status` output lists each run's id, workflow, event and attempt.

A run list alone does not establish all PR checks; use the check links for
ruleset or synthetic-merge runs omitted by the head-SHA filter.

While a workflow is still running, `gh run view --log` and `--log-failed`
refuse logs even for a completed job. Read that job's log directly instead
(`databaseId` in the run's jobs), then inspect its failing step. The installed
GitHub CLI refuses raw logs containing terminal escape sequences unless they
are explicitly allowed, even when stdout is redirected. Export those logs to
a file rather than printing the escaped response in a terminal:

```sh
gh api --allow-escape-sequences \
  'repos/schlessera/brain-kit/actions/jobs/<job-id>/logs' > /tmp/ci-job.log
```

A refused-start job has no execution log; inspect its check-run annotations
instead.

Read the checkout SHA from the actual selected jobs' logs (including verification/pack
jobs); a workflow's `headSha` or PR metadata alone does not establish the tree
those jobs ran. Record the run, attempt, job IDs and checkout SHA. For GitHub's
two-parent PR merge checkout, verify immutable parents and retain its tree:

```sh
ci_checkout=<sha-from-actual-checkout-log>
gh api "repos/schlessera/brain-kit/git/commits/$ci_checkout" \
  --jq '{sha,parents:[.parents[].sha],tree:.tree.sha}'
git fetch origin "$ci_checkout"
git show --no-patch --format='%H %P %T' "$ci_checkout"
test "$(git show -s --format=%P "$ci_checkout")" \
  = "$verified_base $verified_head"
verified_tree=$(git rev-parse "$ci_checkout^{tree}")
```

The local object must agree with the immutable API receipt. Reconcile all
required jobs' checkouts with this proof; investigate different trees rather
than applying one job's receipt to the others. A changed head requires fresh
inspection. If main advanced, inspect the missing commits before refreshing:
rebase only when needed, but request new candidate confirmation for the new base. Record the new base and request confirmation; do not call the earlier receipt current.
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

Optional local full verification uses `bun run check:pr --base origin/main --full`; its
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

## Stacked PR evidence

Load `gh-stack` and follow the
[project stack rules](../../../../docs/process/github.md#stacked-pull-requests).
Run local preflight against the immediate parent ref for each upper layer.
For every PR in the intended merge prefix, record its head and declared base
branch, independently query that base's live Git ref, and inspect its own
selected jobs/checkouts. A two-parent synthetic checkout must have that recorded
parent tip and PR head as parents. Keep contract head-only receipts separate.
Do not substitute live `main` for an upper layer's base or claim its CI tested
the eventual integrated trunk tree.

Read back every included PR's release milestone and all issues it advances,
along with current heads, bases, checks and review state. Confirm the resolved
merge target: numeric arguments prefer stack numbers over PR numbers.
Use `gh stack merge <target> --yes --squash` for a native stack. The installed
CLI has no matching-head option; a final readback reduces the race window but
does not lock heads. Retain the inspected heads and reconcile the actual result
against them. Never substitute `gh pr merge` or `--admin` to bypass a refused
stack merge.

After landing, read each included PR's state and reported merge commit. Fetch
main, prove those commits are ancestors, and inspect their actual parents,
trees and delivered diffs against the inspected layers. Squashing can replace
parent commit identities; do not require every upper squash to have its old
parent branch SHA or apply the ordinary single-PR tree equality blindly.
Reconcile any different integrated tree and verify automatic main-push proof,
then read back issue closure and milestone assignments for every delivered
slice. Queued PRs require actual merge-group and eventual landing evidence.

## Reservation before expensive confirmation

For ordinary PRs, use `bun scripts/integrate.ts confirm <pr> --issues
owner/repo#N,...` before requesting full confirmation. The explicit comma-separated
list accepts at most 100 references, must name at least one issue including
every closing issue, and checks every listed issue against the PR release
milestone. It refuses an empty or incomplete list, or a milestone mismatch,
before taking a lease or spending candidate CI (#3850). It acquires the remote
exact PR/head/base reservation, renews every minute, waits for actual complete
candidate proof, and uses the shared merge path. It first waits for the
newest exact-head contract run and refuses, before taking a lease or spending
candidate CI, when that run is missing, cancelled or failed. A body edit or a
label change starts a fresh one. Edit the body before pushing so that one push
does not start two racing contract runs (#3573). `inspect` shows ownership;
busy callers have bounded retries, never a FIFO queue. Separate `acquire`
requires minute `renew` and explicit `merge --lease`; `release` abandons it.
The lease lasts five minutes with an absolute sixty-minute cap including
queue, proof and merge. `acquire` prints a holder token once; `renew`,
`release` and `merge --lease` need it (`--token`), so only the holding process
can end or extend a live lease. A transient renewal failure is retried next
tick, and a failed `renew <id>` keeps the lease; retry it within the minute.
Do not reacquire to extend an old proof window; a new
candidate/lease needs new confirmation. Maintainer `revoke '<reason>'` records
actor/time/reason and immediately removes the old authority without waiving
proof. Native candidates need separately qualified prefix integration; this
ordinary command rejects them. See the [binding decision](../../../../docs/decisions/ci-utility.md#exact-candidate-integration-reservation).

The merge path also reads the `check:pr` receipt from the PR body. It refuses
a PR with no receipt (`confirm` says so before acquiring), and one whose
skipped, timed-out or preempted checks map to hosted categories the exact-head
proof did not run, naming each. Rerun the check locally and paste the new
receipt, or get the category selected; never edit a receipt by hand
([local check receipts](../../../../docs/decisions/ci-utility.md#local-check-receipts)).

While main is red, a declared fix for the open record, forward fix or
targeted revert alike, may use `bun scripts/integrate.ts confirm <pr>
--fixes-main-run <run-id> --issues owner/repo#N,...`. It dispatches fix probes
that must show the record's failing test files red on the exact base and green
on the exact head, waits for the exact-head fast invariants and squashes under
the reservation. It refuses category-level failures; use ordinary confirmation
for those, and the fix's own main run proves a post-merge category. Never merge a red-main fix any other way
([expedited red-main fixes](../../../../docs/decisions/ci-utility.md#expedited-red-main-fixes)).

While main is red in a fast category (or with an unknown failure set),
`confirm` and `merge` refuse every PR that is not a declared fix, and hosted
proof containing the bad commit is refused or cancelled. Red confined to
post-merge categories (runtime, runtime_host, browser, layout, captures,
endurance) refuses nothing
([hybrid ruling](../../../../docs/decisions/ci-utility.md#hybrid-post-merge-heavy-proof)). Do not retry it; follow [the red-main incident steps](red-main.md)
and resume when `main-status` reports green. A fix or targeted revert PR for
the incident is declared with `bun scripts/integrate.ts declare-fix <pr>` and
then uses this same reservation and merge procedure.

## Merge and verify

Before every merge, assign the PR and each completed/advanced issue a release
milestone using the GitHub skill's "Labels and milestones" procedure. Confirm
the upcoming release for unreleased changes; late verification of already
shipped behavior retains its original delivery milestone. Include docs/test/CI
and partial `Refs` deliveries. Read back `gh pr view --json milestone,closingIssuesReferences`
and `gh issue view --json milestone,state` for every delivered issue. Missing
or stale assignments need correction before merging. Leave unscheduled parent
epics alone unless this PR delivers their initial outcome.

Immediately re-read head/state/reviews/checks and query live main again.
Keep the verified head/base/tree from the passing combined-state inspection:

```sh
bun scripts/pr-status.ts <pr> --expect-head "$verified_head" --expect-base "$verified_base"
git fetch origin main
```

It exits 1 when either moved. `unchanged` says which, and `baseGained` lists
how many files the base gained and which of them this pull request also
changes.

A head mismatch requires new inspection. A base mismatch requires assessment of
the missing commits and new confirmation: request candidate confirmation for the new base; a rebase is needed only when the change requires it. Record unrelated advancement and retain the original tested base/tree;
never report the earlier run as testing a different combined tree. Merge only the inspected,
passing head, a ready PR and satisfied branch rules. A completed partial
slice uses `Refs` and states remaining acceptance/verification work.

```sh
bun scripts/integrate.ts merge <pr> --lease <owned-lease-id> --token <holder-token> \
  --issues schlessera/brain-kit#<advanced-issue>
gh pr view <pr> --repo schlessera/brain-kit \
  --json state,mergeCommit,mergedAt,headRefOid,url
git fetch origin
git merge-base --is-ancestor <merge-commit-sha> origin/main
git show --no-patch --format='%H %P %T' <merge-commit-sha>
test "$(git show -s --format=%P <merge-commit-sha>)" \
  = "$verified_base"
test "$(git rev-parse <merge-commit-sha>^{tree})" \
  = "$verified_tree"
```

The shared command independently verifies selected jobs, actual checkout
identities, milestones and final live ownership before its matching-head
squash. A successful squash returns exit 2: reconcile automatic main jobs and
checkout evidence separately even if a workflow summary is already green.
Direct `gh pr merge` is not the cooperative merge procedure. Preserve branches
while a worktree/worker needs them. Follow a
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
state, and read back the PR and delivered issues' milestone assignments.
Missing merge evidence is unfinished verification, not completion.
Return to the skill's **Finish or hand off** for labels and assignment cleanup.
