---
name: work-issue
description: Work one unassigned, highest-priority agent-ready brain-kit issue through readiness review, implementation, PR fixes and merge, or a documented blocked handoff. Use when asked to pick up and complete an issue; not for listing, triage alone or creating this skill.
---

# Work one brain-kit issue

One invocation handles **one claimed issue** in `schlessera/brain-kit`. Finish
when its PR is merged and reconciled, or its blocker is documented and its
claim released. Do not take the next issue after that handoff.

Requires this checkout, authenticated `gh` with issue/PR write access, git,
Bun and `jq`; also `depot` when Depot CI is enabled. GitHub Project access
is optional.

An end-to-end request authorizes assignment, tracker updates, scoped
implementation, commits, push, PR and merge. Honor narrower session
instructions. Discussing/loading this skill does not authorize starting it.
No package publishing, deployment, paid experiments or unrelated external
messages are implied.

Read [the GitHub skill](../github/SKILL.md), `AGENTS.md`, `ROADMAP.md`'s
binding decisions and `docs/process/github.md`. Use the GitHub skill for
public text screening, label taxonomy, design prompts, dependencies,
follow-ups and human handoffs. Read [the release skill](../release/SKILL.md)
when changing what packages ship, dependencies, versions or publishing.

## Select and claim

Check authentication and the repository remote; fetch `origin/main`.
Preserve existing user work. Use an isolated branch/worktree from remote
main when the checkout is dirty or another task is using it.

Read **all pages** of open `agent-ready` issues, rather than trusting a stale
board view. Exclude assignments, PR objects, epics, `blocked` and all `needs:`
labels. Order a single valid priority `p0`, `p1`, `p2`, `p3`, then oldest
creation time, then lowest issue number. Missing/multiple/unknown priorities
are unsorted: report them without inventing a priority. If no eligible
candidate remains, stop without tracker mutations.

A read-only query using `gh` pagination and standalone `jq` (`gh` cannot
combine `--slurp` with `--jq`). Pipe failure must propagate:

```sh
rtk proxy bash -o pipefail <<'SH'
rtk proxy gh api --paginate --slurp \
  'repos/schlessera/brain-kit/issues?state=open&labels=agent-ready&per_page=100' \
  | rtk proxy jq '
    [.[][]
     | select(.pull_request == null and .state == "open")
     | select((.assignees | length) == 0)
     | [.labels[].name] as $labels
     | select(($labels | index("agent-ready")) != null)
     | select(($labels | index("epic")) == null)
     | select(($labels | index("blocked")) == null)
     | select(all($labels[]; startswith("needs:") | not))
     | [$labels[] | select(startswith("priority:"))] as $priorities
     | select(($priorities | length) == 1)
     | select($priorities[0] | test("^priority: p[0-3]$"))
     | {number, title, url: .html_url, created_at,
        priority: $priorities[0], rank: ($priorities[0][-1:] | tonumber)}]
    | sort_by(.rank, .created_at, .number)'
SH
```

Before claiming the first candidate, check open PRs/recent comments for
active work, including `Refs` links and issue-number branches. An unassigned
issue with a live implementation PR is not free work. Skip it before
claiming; do not duplicate/resume another worker's PR without authorization.

Re-read the candidate's state, labels and assignees. Claim only while it
still qualifies:

```sh
rtk proxy gh issue edit <number> --repo schlessera/brain-kit --add-assignee @me
```

Read back the assignment. If another owner appeared, stop before coding.
Post a short claim comment with a unique claim token and intended branch,
without local/private paths. Record whether this invocation owns the claim.
Assignments are not an atomic lock: serialize workers sharing one GitHub
login. A competing claim requires ownership reconciliation, not erasing
someone else's assignment. Once claimed, a readiness rejection ends this
invocation rather than starting another issue.

## Establish readiness

Read the full issue/comments, parent epic, linked decisions/designs and
dependencies. Verify code citations against fetched source. Check acceptance
criteria, scope exclusions, chosen approach, contract/breaking rulings,
reproducible bug evidence and required access/verification. A shipped fix
with only verification remaining needs verification, not another implementation.
A spike that produces a design/decision is ready when that deliverable is
scoped; do not demand its own result in advance.

Repair routine drift or omissions settled by source/existing rulings. Fold
corrections into the body with a dated explanatory comment. Do not invent a
design, policy, permission or new scope ruling to keep the task moving.

For real gaps, add all relevant labels and comments naming **what is missing,
evidence, the exact next action and completion evidence needed to resume**:

| Missing prerequisite | Label and required detail |
| --- | --- |
| Interaction/visual design | `needs: design`; post the GitHub skill's self-contained design prompt with settled constraints and source pointers. |
| Scope, policy, architecture or breaking-contract ruling | `needs: decision`; state the unresolved question/options and consequences, separating recommendation from approval. |
| Evidence of the reported failure | `needs: repro`; record attempts, conditions and the evidence still needed. |
| Access, credential/login, authorized paid scope or reserved human verification | `needs: human`; finish independent work first, then put the exact human action and sanitized completion evidence in the body. |
| Driving workflow/use case | `needs: use-case`; name the scenario that must be demonstrated. |
| Another issue/approved upstream task | `blocked`; add a canonical `Blocked by #N` line, with public cross-repo references where appropriate. |

Remove `agent-ready` when readiness is false. A fully scoped task blocked
solely on a declared dependency may retain it; `blocked` excludes it from
selection. Human handoff removes `agent-ready` under the GitHub skill's rule.
Preserve type, area, priority and genuine release commitments. Labels describe
gaps; workflow status lives on the board. Then **Finish or hand off** and stop.

## Implement the scoped issue

Create `<type>/<issue-number>-<slug>` from remote main; record its branch in
the claim comment. Implement acceptance criteria in logical, reviewable
groups and commit those groups with conventional titles. Stage only your work.

Follow repository failing-first/runtime/mutation expectations for fixes and
guards. Record the actual failing assertion and restore mutations. Run
appropriate `bun run test`, typecheck/lint/build/browser/packaging checks
required by the change; do not add tests that mirror a low-impact edit.
Keep documentation, moved citations, contract updates and consumer-visible
changesets with the behavior they describe. Audit other instances of a bug
shape before calling it fixed.

Document blockers/omissions in the issue body and a comment while evidence is
fresh. Resolve routine implementation choices within approved scope. A new
product/design/contract ruling uses the readiness labels above; finish
independent work, preserve partial commits and hand off when dependent work
cannot continue. Do not discard progress or expand scope to make a PR green.

File out-of-scope findings/necessary follow-ups via the GitHub skill: check
duplicates, choose the owning repo, give checkable criteria, link the source
issue and attach genuine epic children. A required criterion cannot be
silently moved to a follow-up and declared complete. Public tracker text
never identifies a private-instance follow-up; sanitize the public handoff.

## PR, CI and merge

Before every push, confirm the branch's PR is not already merged/closed.
Open one PR against `main` using the repository template and appropriate
type/area/`contract` labels; do not copy readiness labels onto the PR.

- `Closes #N` means merging meets all acceptance criteria and required
  verification. Otherwise use `Refs #N`, name remaining work and keep the
  issue open. An independently useful completed slice can merge with that
  honest scope; an incomplete/blocked implementation stays draft.
- Include behavior, rationale, validation/mutation receipts, changesets or
  justified absence, and material gaps.
- Follow [CI and merge](references/ci-and-merge.md). Inspect the active CI
  provider's results and logs for the **current head SHA**, fix relevant
  failures, commit/push logical corrections and repeat. Review new issue/PR comments and reviews
  and resolve actionable findings without inventing a required approval.
- A confirmed external/access/design/decision blocker ends the loop with a
  handoff. Diagnose repeated failures; do not rerun indefinitely, weaken a
  gate, dismiss a review or bypass protection to obtain green.
- Once current-head checks pass and actual merge requirements are met,
  merge using `--match-head-commit` and squash. Respect a merge queue and
  monitor actual completion. Do not ask again for permission included in
  the end-to-end request.

## Finish or hand off

Reconcile fresh GitHub state. After merge, fetch main and prove the reported
merge commit is an ancestor of `origin/main`. Check actual issue closure;
never push another fix to a merged branch. Post-merge fixes need a new branch
and issue where appropriate.

Post a concise issue outcome: merged PR/SHA and evidence, or partial
branch/PR, blocker, remaining work and how to resume. Change readiness labels
only when supported; preserve unrelated labels. Required human verification
keeps the issue open under `Refs` and `needs: human` until evidence exists.
Reconcile affected epics/dependants via the GitHub skill/project-sync convention.
Preserve personal board statuses; if this invocation set `In progress`, move
a blocked open item to `Backlog` when project access is available.

**Cleanup runs on every exit after claiming**, including readiness rejection,
implementation/CI/merge blockers and an explicit stop. Re-read the issue; if
it is still open and this invocation still owns the claim, remove only its
own assignment with `--remove-assignee @me` and verify it is gone. Do not
remove another worker's assignment or release a contested shared-account
claim. Keep resumable code/PRs and links. If an API failure prevents comments,
labels or unassignment, report the exact unfinished tracker action; do not
claim a clean handoff. Closed issues may retain assignment as history.

Report the selected issue, outcome, PR/merge or blocker links, checks and any
unfinished action. Do not claim/work another issue automatically.
