# Working through GitHub

The issue tracker is where brain-kit's planned work lives. Not a markdown file,
not a plan document, not a session transcript. This page is the working
agreement: what each label means, what a milestone commits to, what the project
board is for, and what an agent is expected to do before it writes a line of
code.

It is short on purpose. If a rule here needs a paragraph to justify it, the
justification belongs in the thing it governs — `scripts/labels.ts` for the
taxonomy, `.github/ISSUE_TEMPLATE/` for the shape of an issue.

## Where a thing belongs

| It is… | It lives in… |
| --- | --- |
| Planned work, of any size | A GitHub issue |
| A theme that needs several issues | An epic issue, with sub-issues |
| A decision that binds future work | `docs/decisions/`, linked from the issue |
| A question with no work attached yet | A GitHub Discussion |
| A security vulnerability | A private advisory — never an issue |
| Deployment, container or hosting specifics of the maintainer's instance | The private `schlessera/brain-ui` repo, off the board |
| Progress on work in flight | Comments on the issue, and the PR |

**Nothing durable lives in a plan document any more.** `docs/plans/` and the old
`.plan/` tree were both status files and design records at once, which meant
every reader had to work out which lines were still true. Decisions moved to
`docs/decisions/`; open work moved to issues; progress logs were not worth
keeping once the work shipped.

## The five repositories

Three repositories make up the open-source project and two are one person's
private instance of it. AGENTS.md ("The five repositories") is the canonical
statement. This section is the tracker's view of it.

| Repository | Owns | Visibility |
| --- | --- | --- |
| **brain-kit** | Every line of behaviour. The published packages. | public |
| **brain-template** | The starting point for *your brain*: config, skills, empty content. Generated from `template/` here. | public |
| **brain-hosting-template** | The starting point for *self-hosting*: a PWA that manages your brain remotely, with container, compose, proxy and branding over the published packages. | public |
| **brain** | The maintainer's own brain. Personal data. | **private, permanently** |
| **brain-ui** | The maintainer's own hosted PWA. An instance, not a product. | **private, permanently** |

The first three are the product and the only repositories on the project
board. `brain` and `brain-ui` are instances of the two templates: they consume
the public project, and the public project never depends on, links to or
describes them. `brain-ui` is where the hosting template will be extracted
*from*, and it is where a production incident gets written down. **Nothing in
a public repository should link to either one or depend on it existing.**

### Where an issue goes

Ask what the issue is actually about:

- **Behaviour** — what the CLI, the server, the UI or a package *does*. →
  brain-kit, always. Even when the symptom was seen in a deployment.
- **What a generated brain contains** — a config key, a skill, the onboarding
  interview, what the first clone looks like. → brain-template.
- **What a generated host contains** — the Dockerfile, the compose file, the
  proxy, the environment contract. → brain-hosting-template.
- **One deployment's reality** — its host, an incident on it, a migration of
  its volumes. → brain-ui. Its content and data → brain. Neither goes on the
  project board.

When a change needs two of them, each gets its own issue and both carry the
`upstream:` label pointing at the other. **A public issue never restates a
private deployment detail to save a click.**

Before creating or editing an issue in a public repository, run its body
through the same gate the tree is held to — the `github` skill
(`.agents/skills/github/`) has the command.

## Labels

Four namespaces and a flat meta set. The full list with descriptions is
`scripts/labels.ts`; `bun scripts/sync-labels.ts --repo <owner/name>` pushes it
(dry run by default).

- **`type:`** — what kind of work. `feat` `fix` `refactor` `test` `docs` `chore`
  `spike`. **Exactly one per issue.**
- **`area:`** — where it lands, mirroring the package layout. One or more.
- **`priority:`** — `p0` drop everything, `p1` this milestone or the next, `p2`
  wanted but unscheduled, `p3` someday. **No priority label means unsorted**,
  which is an honest state.
- **`needs:`** — what blocks it when the blocker is not another issue:
  `decision`, `design`, `repro`, `use-case`.
- **Meta** — `epic`, `agent-ready`, `blocked`, `contract`, `breaking`,
  `security`, `upstream: …`, plus GitHub's triage set.

**Workflow state has no labels.** Backlog, ready, in progress and done live in
the project board's Status field. A label and a board column tracking the same
fact drift inside a week, and then neither can be trusted.

Two labels carry weight beyond their description:

- **`contract`** means the change touches the machine surface in
  [integration-contract.md](../integration-contract.md). That implies a
  `CONTRACT:` commit prefix and the doc updated in the same commit. Add
  `breaking` when a field is removed, renamed or retyped: that also needs a
  maintainer ruling on the issue before code is written. Applying either label
  is a claim, so check it.
- **`agent-ready`** means a coding agent can take the issue unattended: context
  with real file paths, an explicit out-of-scope section, and acceptance
  criteria somebody else could check. See below.

## Milestones

A milestone is a **release**, because a release is the only thing this repo
actually ships. All `@schlessera/brain-*` packages version in lockstep, so one
milestone covers all of them.

- An issue in the current milestone is a commitment for that release.
- An issue with no milestone is not scheduled. That is most of them.
- `1.0.0` is the stability bar, not a date: the extension interfaces lose
  `@experimental` and the integration contract stops moving under a minor.

Milestones are not themes. A theme is an epic; an epic can span three
milestones, and its sub-issues carry the milestones individually.

## The project board

One project, [**brain-kit roadmap**](https://github.com/users/schlessera/projects/1), spanning the three public repositories: brain-kit, brain-template and
brain-hosting-template. The private instance repositories are never on it:
they have their own private board, whose issues may name a public blocker. A
public issue never names a private one. This board adds the two things labels cannot express: where an item is in flight, and when it is meant
to happen.

| Field | What it is for |
| --- | --- |
| Status | Backlog → Ready → In progress → In review → Done |
| Track | The roadmap theme, matching the epics |
| Priority | Mirrors the `priority:` label, so the board can sort |
| Size | XS/S/M/L — a rough estimate of one sitting versus several |
| Start / Target | Two dates, for the roadmap view only. Intent, never a commitment — an item with neither does not appear there, which is the right default |

`Ready` is the one that matters: it means the issue has been read, it is not
blocked, and it can be picked up now. An agent picking work should filter
`Status: Ready` and take the top item by priority.

**Status is derived, not typed.** `bun scripts/sync-project.ts --apply`
computes `Backlog`, `Ready` and `In review` from the labels and from whether an
open PR says it closes the issue. `In progress` and `Done` are statements about
a person or an agent rather than about labels, so the script reads them and
leaves them alone.

The `blocked` label is checked against the blockers it names. An issue that
waits on another says so on its own line in its body, starting with the
references: `Blocked by #42`, `Blocked by #42 and #43`, or
`Blocked by schlessera/brain-kit#42` across repositories. Write it as a plain
line at the start of the line, optionally as a top-level bullet. Do not indent
it, quote it, nest it, make it a task item or put it inside an HTML comment.
Commentary may follow the list as long as it names no other reference. When
every issue it names is closed (a pull request counts once it has merged), the
script reports it, and with `--apply` posts a one-line comment naming the
closed blocker and removes the label. In the same run it then re-derives
Status, unless the Status is `In progress` or `Done`, and the issue lands in
Ready if nothing else holds it back. An issue labelled `blocked` keeps its label and is
reported as unverifiable in four cases. It has no such line. Some other line
in the body says "blocked by" in any form: prose, a quote, a heading, an
example in a code block, an HTML comment. A declaration names another
reference after its list. Or a blocker's state cannot be read. The script clears a label
only on declarations it read in full. Closing a blocker unblocks nothing by itself — the line has to be there,
and the script has to run.

That is what the `blocked` label is for, and why it is worth applying: four of
the container issues and two of the template ones are `agent-ready` and *not*
pickable, because each waits on the one before it. Without `blocked` they would
sit in the Ready view as traps.

## The lifecycle

1. **File.** Use a template. An issue with no acceptance criteria is not ready,
   whatever else it has.
2. **Triage.** `type:`, `area:`, a priority if it is sorted, and a milestone if
   it is committed. Add it to the board.
3. **Ready.** Context is complete and nothing blocks it. Add `agent-ready` if a
   stranger could implement it from the body alone.
4. **In progress.** Assign yourself, move the card. One issue at a time per
   branch: `<type>/<issue-number>-<slug>`.
5. **In review.** Open the PR with `Closes #<n>` in the body. The PR template's
   checklist is the merge bar.
6. **Done.** The PR merging closes the issue. An epic closes when its last
   sub-issue does *and* its definition of done is met — those are not the same
   thing.

An issue that turns out to be wrong gets closed with a comment saying why.
`wontfix` is a legitimate outcome and does not need an apology.

Between those steps the issue has to stay true: its body is the current
specification and its comments are the history. Corrections are folded into the
body, a ruling is recorded where it unblocks the work, `blocked` comes off when
its last blocker closes (`sync-project.ts --apply` does it for a readable
`Blocked by` line), and a duplicate is closed into one survivor. The `github`
skill's "Keeping an issue true" has the procedure.

## What an agent does before writing code

This repo is operated by coding agents, so this is a contract and not advice.

1. **Read the issue, its epic, and every link in both.** The epic holds the
   shared context the task deliberately does not repeat.
2. **Check the binding decisions.** [ROADMAP.md](../../ROADMAP.md) "What binds
   future work" and `docs/decisions/`. A task that violates one of those is a
   task that was filed wrong — say so on the issue rather than implementing it.
3. **Confirm the context is still true.** Issue bodies cite `file:line`. Code
   moves. Verify before building on a citation, and correct the issue if it has
   drifted.
4. **Work the acceptance criteria, not the title.** Each one is a thing to
   prove. A fix's test is shown failing on the tree before the change.
5. **Stay inside the scope.** Everything the issue lists as out of scope stays
   out. Something genuinely necessary that the issue did not anticipate gets a
   comment, and its own issue if it is more than a line.
6. **Comment what changed about the plan**, not what you did — the diff says
   what you did. Record the decisions you made that the issue did not make for
   you.

## Filing an issue from a session

Work found mid-session that is real but out of scope gets filed, not fixed and
not forgotten. Keep it honest: what was observed, where, and why it matters.
`needs: repro` is better than a confident guess, and an issue with no acceptance
criteria is a note to self — say so rather than labelling it `agent-ready`.

The repo-local `github` skill (`.agents/skills/github/`) carries the commands
and the exact body shapes.

## See also

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — prerequisites, how to run things,
  what gets merged.
- [`AGENTS.md`](../../AGENTS.md) — the hard rules that bind every change.
- [`docs/decisions/`](../decisions/) — decisions that bind future work.
- [`docs/integration-contract.md`](../integration-contract.md) — the machine
  surface the `contract` label refers to.
