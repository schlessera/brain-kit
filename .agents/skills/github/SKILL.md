---
name: github
description: Use when filing, triaging, picking up, updating or closing work in the brain-kit, brain-template, brain-hosting-template or brain-ui issue trackers — including creating epics and sub-issues, choosing labels and milestones, putting items on the project board, opening a PR against an issue, and deciding which repository an issue belongs in. Also use before recording found work mid-session.
compatibility: Requires the `gh` CLI, authenticated. Issues, labels, milestones and sub-issues need only repository access. The project board additionally needs the `project` scope on an OAuth token or classic PAT (`gh auth refresh -s project` for an OAuth login) — a fine-grained PAT cannot reach it at all; see "Labels and milestones".
---

# Working the brain-kit trackers

**This skill is the procedure. [`docs/process/github.md`](../../../docs/process/github.md)
is the agreement it implements** — read that first if you are deciding
*whether* something should be an issue. Read this when you are about to run a
command.

Five repositories. Three are the open-source project and share one board; two
are the maintainer's private instance and are never on it. AGENTS.md ("The
five repositories") is the canonical statement.

| Repo | Visibility | Owns | On the board |
| --- | --- | --- | --- |
| `schlessera/brain-kit` | public | Every line of behaviour. The packages. | yes |
| `schlessera/brain-template` | public | The starting point for a brain: config, skills, empty content. | yes |
| `schlessera/brain-hosting-template` | public | The starting point for a hosted PWA: container, compose, proxy. | yes |
| `schlessera/brain` | **private, permanently** | The maintainer's own brain. Personal data. | no |
| `schlessera/brain-ui` | **private, permanently** | The maintainer's own hosted PWA. An instance, not a product. | no |

## Which repo

Ask what the issue is **about**, not where the symptom appeared:

- **Behaviour** — what the CLI, the server, the UI or a package does →
  `brain-kit`, always. A bug seen in a deployment is still a package bug.
- **What a generated brain contains** — a config key, a skill, the onboarding
  interview → `brain-template`.
- **What a generated host contains** — the Dockerfile, compose, the proxy, the
  environment contract → `brain-hosting-template`.
- **The maintainer's deployment** — its host, an incident on it →
  `brain-ui`. Its content and data → `brain`.

`brain` and `brain-ui` are instances of the two templates. They consume the
public project, and the public project never depends on them. The hosting
template will be extracted *from* `brain-ui`. **Nothing public links to either
one or depends on it existing.**

When a change needs brain-kit and a template, file two issues and cross-link
them with the `upstream:` labels. The templates have no labels for each other;
work spanning both goes through a brain-kit issue that links each. When one side is the private instance, only the private
issue links: a public issue never names, labels or links a private one, and
never restates a private deployment detail to save the reader a click.

Before creating or editing an issue in any public repository, run its body
through the same gate the tree is held to:

```sh
bun -e 'import {scanText} from "./scripts/check-leakage.ts";
  const t = await Bun.file(process.argv[1]).text();
  const f = scanText("body", t);
  console.log(f.length ? f : "clean");' /tmp/issue-body.md
```

A hit means the text names a person, a client or a piece of personal
infrastructure. Rewrite it; do not weaken the gate.

## Filing an issue

Write the body to a file and pass `--body-file`. Inline `--body` mangles
backticks and newlines through the shell.

```sh
gh issue create --repo schlessera/brain-kit \
  --title "ui-server: refuse a turn when the session has no principal" \
  --body-file /tmp/issue-body.md \
  --label "type: feat" --label "area: ui-server" --label "priority: p2"
```

The body follows `.github/ISSUE_TEMPLATE/task.yml`: **Context** (with real
`file:line` pointers), **Scope**, **Out of scope**, **Acceptance criteria**,
**Verification**, **Contract impact**. An issue missing any of those is not
`agent-ready`, whatever else it has.

Four rules that decide whether the issue is usable six weeks from now:

1. **Cite the code.** `packages/ui-server/src/middleware/auth.ts:253`, not "the
   auth middleware". A reader should never start by searching.
2. **Write the out-of-scope section first.** It is the section that stops a
   one-file change becoming a refactor, and it is the one people skip.
3. **Make every acceptance criterion checkable by someone else.** "Works
   correctly" is not one. "A symlinked root resolves to the same decision as its
   target, proven by a test that fails before the change" is.
4. **Title it `<area>: <what is wrong or wanted>`.** `core: a stats health ratio
   rounded to its threshold reads as contradicting its verdict`, not
   `fix(core): …` and not `CONTRACT: …`. Commit prefixes belong on commits; the
   type, `contract` and `breaking` are labels. An epic is `Epic: <outcome>`.

When the work waits on another issue, say so on its own line in the body —
`Blocked by #42` — and add the `blocked` label. The line is what lets the next
reader, and a script, find the dependant when #42 closes.

## Epics and sub-issues

An epic holds the context its tasks would otherwise repeat, and is never coded
directly. Create it with `.github/ISSUE_TEMPLATE/epic.yml`, then attach tasks.

`gh` 2.89 has no `--parent` flag, so linking goes through the REST API, and the
API wants the sub-issue's **database id**, not its number:

```sh
REPO=schlessera/brain-kit
SUB_ID=$(gh api "repos/$REPO/issues/42" --jq .id)
gh api -X POST "repos/$REPO/issues/7/sub_issues" -F sub_issue_id="$SUB_ID"
```

Limits worth knowing before designing a hierarchy: 100 direct sub-issues per
parent, eight levels of nesting, and **one parent per issue**. Two epics cannot
share a task — split the task or merge the epics.

Attach every issue filed from an epic's work, not only the ones planned up
front. "Part of #39" in prose does not put it in the epic's progress count or
on its track; the API call does. Check the epic's outcome, scope and exclusions:
discovery during its work or a shared dependency alone does not establish
membership. Use references for supporting work whose full scope is elsewhere.

Tracks are mapped in `scripts/sync-project.ts`. Add new epics there and keep
standalone assignments consistent; child references preserve their repository,
so template tasks inherit from a brain-kit epic without colliding with local
issue numbers. Sync handles inheritance for the configured epics. An issue can
have a track while remaining standalone.

List what is attached:

```sh
gh api "repos/$REPO/issues/7/sub_issues" --jq '.[] | "\(.number) \(.title)"'
```

## Labels and milestones

The taxonomy for the three public repositories lives in `scripts/labels.ts`
and is pushed with `bun scripts/sync-labels.ts --repo <owner/name> --apply`
(dry run without `--apply`). The private instance repositories keep their own
taxonomy and sync script in their own trees. Never create a label by hand — it will be silently different from
the one in the manifest, and the next sync will not fix it because the manifest
does not know it exists.

Exactly one `type:`. At least one `area:`. A `priority:` only if it is actually
sorted — an unprioritised backlog item is honest, a guessed `p2` is not.
Workflow state is never a label; it is the board's Status field.

**The board may be out of reach, and that is fine.** *brain-kit roadmap* is
owned by a user account, not an organisation, and GitHub exposes user-owned
ProjectsV2 only to an OAuth token or classic PAT. On a fine-grained PAT there is no
permission to grant — the setting does not exist. The failure misleads on its
way past, too: `viewer.projectsV2.totalCount` answers, while selecting the node
under it returns `FORBIDDEN / Resource not accessible by personal access token`.
Counting works, reading does not.

GitHub documents this under [fine-grained PAT limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations).
If the current token cannot access the board, file the issue with its labels
and milestone. The `project-sync` workflow adds it and derives its Status
within seconds: an issue event syncs that issue, and a PR event syncs the
issues the PR closes. A full sweep runs daily and covers the template
repositories. To run the sweep now, trigger it:

```sh
gh workflow run project-sync --repo schlessera/brain-kit
```

It costs about 520 of the account's 5,000 GraphQL points per hour, so do not
trigger it in a loop. Do not run `--apply` from a terminal while the workflow
exists: it can overlap a workflow run and post a notice twice. The dry run (no
`--apply`, optionally `--issue owner/repo#N`) is safe from anywhere, with a
token that has `project` and `read:org`.

A `needs:` label says what is blocking the work. `needs: design` is the one
that is useless on its own — see "Issues that need design" below for what has
to be posted with it. `needs: human` also requires the exact next action and
completion evidence in the body — see "Handing work to a human" below.

A milestone is a release. Attach one only when the work is committed to that
release; an unresolved design or decision is not a commitment. A decided issue
waiting on human verification may retain its release commitment. Rule first,
then schedule:

```sh
gh issue edit 42 --repo schlessera/brain-kit --milestone "0.37.0"
```

## Issues that need design

An issue needs design when the remaining work is a judgment about how something
looks, reads or behaves, and the code cannot settle it: a component with three
defensible fixes that each change its rhythm, a surface that exists on one form
factor and not the other, a control whose placement is the whole question, a
security shape whose answer is what the user is shown. Label those
`needs: design` **on top of** their `type:` and `area:` labels, and do not label
them `agent-ready` — an agent handed a design question invents an answer and
nobody can tell it apart from a decided one.

Two cases that look like this and are not:

- **A spike whose deliverable is the design.** It is not blocked on a design
  drop; it produces one. Leave it `agent-ready` and post the prompt anyway.
- **A technical decision with a visual consequence.** If the blocking question is
  which pipeline draws something, that is `needs: decision`. Say in the body
  that design follows the answer.

A `needs: design` label on its own is a shrug. Post a comment with it that states
**what kind of design work is missing** and carries a prompt somebody can paste
into Claude to do it. The comment has two parts:

1. **Two or three sentences of framing**, in the issue's own terms: what is
   already decided, what is left, and why the code cannot decide it.
2. **A fenced prompt block**, self-contained, because whoever runs it will not
   have this conversation's context. It carries:
   - **Read first** — the `file:line` pointers, the decision records that bind,
     the issue and its epic. Same standard as an issue body: a reader should
     never start by searching.
   - **The problem**, stated concretely, with the real failing case.
   - **Design** — the specific questions to answer, enumerated. Not "design the
     component"; "decide what the map does at 2, 8 and 30 pins, and where the cap
     is".
   - **Requirements to hold** — the constraints that make a wrong answer
     expensive: binding decisions (`docs/decisions/`), the data-only block rule,
     visual baselines asserted in CI, 320px legibility, accessible names, touch
     targets, the honesty rules (an unknown cost never reads as `$0`), and what
     the design may **not** change.
   - **Deliverable** — what comes back, including ASCII mocks at the widths that
     matter. A design that was never drawn at 320px has not been designed.

Two rules the prompts are worth nothing without: **name the binding decision by
its record**, because a design that contradicts D37 is thrown away, and **say
which answers are acceptable outcomes** — "a documented no closes this issue" is
often the right answer and a prompt that does not offer it will not get it.

Design lands like anything else: as a comment on the issue, or a `docs/plans/`
entry if it is big enough to outlive the thread. It is not a status field on a
document in this repo.

## Picking up work

```sh
gh issue list --repo schlessera/brain-kit \
  --label agent-ready --state open \
  --json number,title,labels,milestone
```

The label query is a candidate list, not proof that work is pickable. Exclude
issues with `blocked` or any `needs:` label, and epics. The board's `Ready`
view applies those checks. If `agent-ready` and `needs: human` coexist, remove
`agent-ready`; do not attempt the human action.

Then, before writing code — this is the part that is skipped and should not be:

1. Read the issue, its epic, and every link in both.
2. Check it against `ROADMAP.md` "What binds future work" and `docs/decisions/`.
   A task that violates a binding decision was filed wrong. Say so on the issue
   instead of implementing it.
3. **Verify the `file:line` citations still point at what the issue claims.**
   Code moves; issue bodies do not. Correct the issue if it has drifted.
4. Work the acceptance criteria one at a time. A fix's test is shown failing on
   the tree before the change.

Branch as `<type>/<issue-number>-<slug>`, e.g. `feat/42-session-principal`.

## Handing work to a human

Use `needs: human` when the next required action can only be performed by a
human: account login approval, supplying a credential or granting access,
interactive publishing, or verification explicitly reserved for the maintainer.
Use `needs: decision` for a ruling, and `needs: repro` for a missing reproduction.
A browser check or keyed measurement is not automatically human work: an
authorized agent with the required access can perform it.

Finish independent agent work first. A human prerequisite blocks immediately;
a planned human check after implementation does not block coding now. At handoff:

1. Fold the current state into the body: what is complete, the exact human
   action remaining, and the evidence needed to finish. Add a dated correction.
   Public evidence contains no credentials or deployment details.
2. Add `needs: human` and remove `agent-ready` in the same edit. Remove an old
   `needs: repro` only if no reproduction is missing; retain other real blockers.
   The label belongs in `scripts/labels.ts` and is synced from there, never
   created by hand.
3. Keep the issue open. A PR that leaves this action uses `Refs #N`, not a
   closing keyword, and names it under "Anything left open". If the board item
   was manually `In progress`, move it to `Backlog`; sync preserves `In progress`
   and `Done`, while derived statuses already respect every `needs:` label.
4. When the action is completed, record the result and remove `needs: human`.
   Restore `agent-ready` only if agent work remains, its criteria are complete,
   and nothing else blocks it. If all criteria and verification are met, close
   with the completion evidence instead.

## Keeping an issue true

An issue is read by someone who was not there. The body is the current
specification; the comments are the history of how it got that way. Every rule
below exists because the tracker drifted without it.

- **Fold corrections into the body.** When a comment corrects an issue's
  figures, scope or acceptance criteria, edit the body in the same sitting and
  end it with a dated line saying what changed. Do not leave the reader to
  reconcile ten comments against a body that contradicts them. A banner reading
  "parts of this body are wrong, see below" means this step was skipped.
- **Record a ruling where it unblocks.** When a `needs: decision` is answered,
  comment `**Decision (maintainer, <date>):** …` with the option chosen and what
  it implies, point the body's acceptance criteria at that branch, remove the
  `needs:` label, and add `agent-ready` if the criteria are now complete. A
  ruling that binds later work, not only this issue, also gets a
  `docs/decisions/` record — file it as its own issue if it is not written now.
- **Clear `blocked` when the blocker closes.** The label does not clear itself.
  The `project-sync` workflow clears it from every issue whose
  `Blocked by #N` lines all name closed issues, and comments saying which. The
  comment carries a marker naming the blockers, so a run that fails part way
  comments only once when it is retried. Closing an issue syncs the issues
  that name it as a blocker straight away, and the daily sweep catches the
  rest. Concurrency serializes each event target, but an issue-close run and
  its closing PR's run can reach the same dependant concurrently. The marker
  makes sequential retries idempotent; it does not exclude concurrent notices.
  A manual sync is a `gh workflow run`, not a terminal `--apply`, which would
  add another uncoordinated writer. A blocker outside the
  board's three repositories is never looked up and reads as unverifiable. The dry run lists those issues, plus every `blocked` issue it
  cannot verify. That is either a problem with the text, so fix the text. There is no
  declaration, some other line says "blocked by", or a declaration names
  another reference after its list.
  Or it is a blocker whose state `gh` could not read, so check `gh auth status`.
  Or it is a pull request that closed without merging, which never counts as
  closed. Without
  running the script, find what named a closed issue by hand:

  ```sh
  gh issue list --repo schlessera/brain-kit --state open --label blocked \
    --search '"#42" in:body' --json number,title
  ```

  The search is fuzzy; read each hit before removing its label.
- **Keep one of two duplicates, and check before closing.** Keep the
  better-scoped one, or the older if they are equal. Move anything the other has
  into the survivor's body, then close the other pointing at it. Before closing
  your own issue into another, confirm the other is open and nobody is closing
  it into yours: two authors each deferring to the other left one question with
  no open issue at all.
- **Epic state is a dated comment.** When an epic's breakdown moves, post
  what is done, what is open and in what order, dated. Rewrite the epic body
  only where it is now wrong, not to track progress; the sub-issue list is the
  progress.
- **A model's citation audit is a lead, not a result.** When an automated pass
  reports a drifted `file:line` or a fixed defect, open the line before
  rewriting the body. Such passes misread a moved comment as a missing one, and
  a correct paragraph elsewhere in the file as the fix.

## Closing it

The PR normally closes the issue; do not close it by hand before merging. If
required human verification remains, follow "Handing work to a human" instead:
use `Refs #N` and close only after the required result is recorded.

```sh
gh pr create --repo schlessera/brain-kit --fill --body-file /tmp/pr-body.md
```

The body says `Closes #42` and follows `.github/PULL_REQUEST_TEMPLATE.md`. If
any acceptance criterion is not met, name it in "Anything left open" — a
silently dropped criterion is the failure this whole structure exists to
prevent.

A PR that touches `docs/integration-contract.md` also carries the `contract`
label, not only the `CONTRACT:` title. The `contract` check
(`scripts/check-contract-pr.ts`) fails without it, and an issue body that says
"no contract impact" does not make it optional. Add it when opening the PR
(`--label contract`); the check re-runs on `labeled`.
Neither `--fill` nor the MCP `create_pull_request` tool adds labels, so add
them in the same step, with the issue's `type:` and `area:` labels too.

An epic closes when its last sub-issue closes **and** its definition of done is
met. Those are not the same thing, and the gap between them is usually docs.

After the merge, look for issues that named this one as a blocker (see "Keeping
an issue true") and clear their `blocked` label.

## Filing found work mid-session

Something real, out of scope, and about to be forgotten gets an issue before the
session ends. Keep it honest:

- Say what was **observed**, where, and why it matters. Not what you suspect.
- No acceptance criteria yet? Then it is a note, and it does not get
  `agent-ready`. Say "needs scoping" in the body.
- Cannot reproduce it? `needs: repro`, and write down what you tried.

## When something here is wrong

This skill records what actually works. A command that has changed, a limit that
bit, an API shape that moved — fix it here in the same PR that discovered it,
the way the `release` skill is maintained. A trap recorded once is a trap that
does not cost a second session.
