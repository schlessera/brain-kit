---
name: github
description: Use when filing, triaging, picking up, updating or closing work in the brain-kit or brain-ui issue trackers — including creating epics and sub-issues, choosing labels and milestones, putting items on the project board, opening a PR against an issue, and deciding which of the two repositories an issue belongs in. Also use before recording found work mid-session.
compatibility: Requires the `gh` CLI, authenticated. Sub-issue and project operations additionally need the `project` scope — `gh auth refresh -s project`.
---

# Working the brain-kit trackers

**This skill is the procedure. [`docs/process/github.md`](../../../docs/process/github.md)
is the agreement it implements** — read that first if you are deciding
*whether* something should be an issue. Read this when you are about to run a
command.

Four repositories, one workflow:

| Repo | Visibility | Owns |
| --- | --- | --- |
| `schlessera/brain-kit` | public | Every line of behaviour. The packages. |
| `schlessera/brain-template` | public when real | The starting point for a brain: config, skills, empty content. |
| `schlessera/brain-hosting-template` | public when real | The starting point for self-hosting: container, compose, proxy. |
| `schlessera/brain-ui` | **private, permanently** | One person's actual deployment. An instance, not a product. |

## Which repo

Ask what the issue is **about**, not where the symptom appeared:

- **Behaviour** — what the CLI, the server, the UI or a package does →
  `brain-kit`, always. A bug seen in a deployment is still a package bug.
- **What a generated brain contains** — a config key, a skill, the onboarding
  interview → `brain-template`.
- **What a generated host contains** — the Dockerfile, compose, the proxy, the
  environment contract → `brain-hosting-template`.
- **One deployment's reality** — its host, its data, an incident on it →
  `brain-ui`.

`brain-ui` is the one to get right. It is not "the hosting repo"; it is
somebody's running installation, and the hosting template will be extracted
*from* it. **Nothing public links to it or depends on it existing.**

When a change needs two repos, file two issues and cross-link them with the
`upstream:` labels. A public issue never restates a private deployment detail
to save the reader a click.

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

Three rules that decide whether the issue is usable six weeks from now:

1. **Cite the code.** `packages/ui-server/src/middleware/auth.ts:253`, not "the
   auth middleware". A reader should never start by searching.
2. **Write the out-of-scope section first.** It is the section that stops a
   one-file change becoming a refactor, and it is the one people skip.
3. **Make every acceptance criterion checkable by someone else.** "Works
   correctly" is not one. "A symlinked root resolves to the same decision as its
   target, proven by a test that fails before the change" is.

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

List what is attached:

```sh
gh api "repos/$REPO/issues/7/sub_issues" --jq '.[] | "\(.number) \(.title)"'
```

## Labels and milestones

The taxonomy lives in `scripts/labels.ts` and is pushed with
`bun scripts/sync-labels.ts --repo <owner/name> --apply` (dry run without
`--apply`). Never create a label by hand — it will be silently different from
the one in the manifest, and the next sync will not fix it because the manifest
does not know it exists.

Exactly one `type:`. At least one `area:`. A `priority:` only if it is actually
sorted — an unprioritised backlog item is honest, a guessed `p2` is not.
Workflow state is never a label; it is the board's Status field.

A milestone is a release. Attach one only when the work is committed to that
release:

```sh
gh issue edit 42 --repo schlessera/brain-kit --milestone "0.37.0"
```

## Picking up work

```sh
gh issue list --repo schlessera/brain-kit \
  --label agent-ready --state open \
  --json number,title,labels,milestone
```

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

## Closing it

The PR closes the issue; do not close it by hand.

```sh
gh pr create --repo schlessera/brain-kit --fill --body-file /tmp/pr-body.md
```

The body says `Closes #42` and follows `.github/PULL_REQUEST_TEMPLATE.md`. If
any acceptance criterion is not met, name it in "Anything left open" — a
silently dropped criterion is the failure this whole structure exists to
prevent.

An epic closes when its last sub-issue closes **and** its definition of done is
met. Those are not the same thing, and the gap between them is usually docs.

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
