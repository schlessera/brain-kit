# `brain sync` decides by rule, asks Jev two questions, and leaves the agent the rest (2026-09-28)

Through 0.38, bare `brain sync` handed the whole workflow to a coding agent: the
`/sync` skill told it how to class files, write commit messages, merge
conflicted notes by a strategy table, reconcile stashes and retry a rejected
push, and the CLI verbs only did the git plumbing. Most of those steps have a
rule, and an agent following a rule is slow, costs a session on every
scheduled sync, and follows it differently from run to run. A brain with no
agent runner could not sync at all.

**Decision: the CLI executes every step that has a rule, Jev answers the two
judgments that have a fixed answer set, and the agent gets only what needs
written text or a person.** `brain sync run` is the whole sync, with no
agent. Bare `brain sync` runs it and calls the agent only for what it hands
back.

## The decisions

1. **A pull finishes what an earlier sync left pending, then pulls (#328,
   option A).** A merge whose only conflicts were the derived caches, a squash
   left by `branch.main.mergeOptions=--squash`, or a conflicted stash pop used
   to leave the next pull reporting `synced` while `origin/main` was not in
   HEAD. `pull` now reads the pending state first (`pendingState`,
   `packages/core/src/lib/sync/merge-state.ts:69-81`), unions the caches among
   the unmerged paths, and concludes it by kind once nothing is unmerged
   (`conclude`, `packages/core/src/lib/sync/merge-state.ts:255-299`): a merge
   or a squash is committed, a stash-pop leftover is unstaged and never
   committed, and its stash entry is left for stash reconciliation. A rebase,
   cherry-pick, revert or am in progress is never finished: the pull reports
   `merge-failed` with the reason. Then the normal pull runs, and if
   `origin/main` is still not an ancestor of HEAD, it runs once more.
   `synced`, `fast-forwarded` and `merged` therefore imply that HEAD contains
   `origin/main`; when a second pass cannot make that true, the result is
   `merge-failed`, never a loop.
   - *Rejected: option B, refuse any pending state and tell the user.* It is
     what the old skill's "Resolve leftover repo state in place" rule already
     asked an agent to do by hand, and an unattended sync has no user to tell.

2. **Conflicted notes merge by deterministic strategies.** The strategy comes
   from what the file is, first match wins (`strategyFor`,
   `packages/core/src/lib/sync/resolve/strategy.ts:56-68`): a derived cache,
   code or `CLAUDE.md`/`AGENTS.md`, the type's `mergeStrategy`, an
   `_index.md`, a `Timeline` heading, else `synthesize`. The strategies are the
   old skill's table made exact: three-way per frontmatter field, per
   section, then per block, with every block of the output taken verbatim from
   a side. The merge never writes text neither side wrote, so there is no
   generated sentence to review. Code, binaries, files over 100 KB and
   markdown that does not parse are left unresolved (`planMergeLF`,
   `packages/core/src/lib/sync/resolve/plan.ts:122-145`).
   - *Rejected: let an LLM write the merged note.* It is the only option that
     can drop a fact silently, and a sync's first rule is that it never drops
     content. A merge built from verbatim blocks can at worst keep a
     duplicate, which a person sees and removes.
   - *Rejected: git's line merge with conflict markers committed.* Markers in
     a note break its frontmatter and the index.

3. **Two judgments go to Jev, under D42's rules.** A block both sides
   changed, and a table row with no `Updated` column to decide it, is a pair:
   are they the same fact, does one replace the other, or are both worth
   keeping? And an `UNKNOWN` file is either an artifact or content to track.
   Both are choices over a fixed set, which is what TypeSafe AI's Jev answers
   with calibrated probabilities. The rules are D42's
   ([design-kit.md](design-kit.md), section D42): progressive enhancement,
   never a dependency. The judge is enabled only with `TYPESAFE_API_KEY` set
   and `sync.judge` not `"off"`, and a missing key, a timeout, an error or a
   low confidence all mean the deterministic default (`createSyncJudge`,
   `packages/core/src/lib/sync/judge.ts:582-645`). Differences from D42: the
   CLI is one-shot, so there is no breaker; instead the judge stops asking for
   the rest of the sync after its first failed request. The deadline is 10 s
   per request rather than 2 s, because nothing is streaming to a person while
   it waits. Jev never decides recency: it reads dates as text, so code
   compares `updated` and the dates in a table or a timeline.

4. **Thresholds, and a pair must agree with itself.** The lines are 0.8 for a
   file, 0.8 for "same fact", 0.85 for a supersede and 0.6 for "distinct"
   (`SYNC_JUDGE_THRESHOLDS`, `packages/core/src/lib/sync/judge.ts:53`). A
   decision that drops a passage needs more confidence than one that keeps
   both. Every pair is asked twice in one request, with the sides as A and B
   in both orders, and is used only when the two answers agree after the
   supersede direction is mapped back and both clear the line (`gatePair`,
   `packages/core/src/lib/sync/judge.ts:456-464`). Jev does not promise that
   two phrasings of one question agree, and a decision that moves with the
   order the sides were shown in is not one to delete text on.

5. **Unjudged means keep both.** A pair nobody decided keeps both passages,
   the newer side first by frontmatter `updated`, ours first on a tie
   (`private judge`, `packages/core/src/lib/sync/resolve/plan.ts:290-311`). An
   unjudged file stays `UNKNOWN` and is left for the agent or the report. The
   inbox type (`note`) uses `keep-both` for the whole file, as the old skill's
   table did: theirs is written beside ours as `<name>-remote.md`.

6. **The agent keeps three things.** A `code-merge` conflict, which needs
   written code; an `UNKNOWN` file the judge did not decide; and a
   `MEDIA`/`LARGE` file, which a person must approve because git keeps it
   forever. `run` reports `needs-judgment` for an unresolved conflict, which it
   leaves in progress with nothing pushed, and for a file holding conflict
   markers, which it leaves uncommitted; unknown and media files
   are listed as leftovers of a `complete` sync, never committed. `run`
   exits `0` complete, `1` failed and `3` needs-judgment. `3`, not `2`,
   because the CLI's contract reserves `2` for an internal failure, and a
   conflict left for judgment is an expected outcome, not a fault. Bare
   `brain sync` calls the agent for a conflict or an unknown file, and for
   media only with a terminal attached, since unattended the answer is always
   "leave it".

7. **Bare `brain sync` changes, as a breaking contract change.** It used to
   run the agent unconditionally, print only the agent's text, and exit `1`
   without an agent runner (`docs/integration-contract.md`). It now runs
   `run`, prints its report, hands over to the agent only as decision 6 says,
   and without an agent runner exits with `run`'s code. The maintainer ruled
   for this on 2026-09-28, recorded on #328. Callers keep calling bare
   `brain sync`, the hosted server included, and a sync with nothing to judge
   costs no agent session.
   - *Rejected: keep bare `brain sync` compatible and let each caller call
     `run` first.* Every caller, the hosted server and every cron line, would
     carry the same fallback logic, and one that did not would keep paying
     for an agent session on every sync.

Commit messages come from a template (`<Verb> <domain>: <titles>`), with the
files in the body. An agent may rewrite them through `commit --plan` and
`commit --plan-file`, which re-check the files against the tracked set
(`applyCommitPlan`, `packages/core/src/lib/sync/commit.ts:273`). Stash
entries are dropped only when the working tree already contains them, and
popped only when they are autostashes that apply cleanly and stage no
version a pop without `--index` would lose
(`reconcileStashes`, `packages/core/src/lib/sync/stash.ts:320`).

Because `run` works unattended, it refuses anything it cannot prove is its
own. It concludes only a merge or squash of commits `origin/main` already
holds, and only when nothing else is staged beside it but the copies its own
resolution wrote (keep-both's `<name>-remote.md`, still as written) and the
derived caches post-sync rewrites. It never commits or pushes a file that
holds conflict markers, of git's default size or a larger
`conflict-marker-size`. It ignores only unmistakable
secrets (`.env`, `.env.*`, `*.key`, `*.pem`); a name that merely looks like
one is left for the agent. It keeps a stash entry unless the working tree
already holds its change in context. A failed commit, post-sync failure,
diverged heads, a stash drop or pop git refuses, or an ignore check git
cannot run end the run `failed`, never `complete`. These rules came out
of an adversarial review of the first cut, which found each of them missing.

## What was measured

Jev (`jev-1.13.0`) on the two keyless eval sets in
`packages/core/fixtures/sync-judge/`, three repeats each, scored at the
thresholds above with `bun scripts/measure-sync-judge.ts --set all --repeat 3
--min-precision 0.9`:

| Set | Items × repeats | Accuracy | Coverage at the line | Precision at the line | Order consistency | Repeat agreement | p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| files | 40 × 3 | 98.3% | 89.2% | 100% (107/107) | — | 97.5% | 331 / 378 ms |
| pairs | 58 × 3 | 94.8% | 51.1% | 100% (89/89) | 96.6% | 100% | 514 / 523 ms |

Accepted pair decisions, by true label: same-fact 36 of 42, distinct 42 of
45, theirs-supersedes 10 of 45, ours-supersedes 1 of 42. No decision that
cleared its line was harmful, meaning none dropped a passage that should have
been kept.

## What it says

- **At these lines, Jev is safe to act on.** Every decision that cleared its
  line was right, in both sets. For files it decides nine in ten, so most
  `UNKNOWN` leftovers never reach an agent.
- **Supersedes rarely clear the line.** 11 of 87 supersede cases were
  accepted. The rest fell below 0.85 in at least one order, or the two
  orders disagreed. Those pairs fall back to keeping both, which is the pre-Jev behaviour
  and the safe one: the cost is a duplicate passage, not a lost one.
  `resolve` says so in each note ("not judged, kept both"). Lowering the line
  or dropping the order check would raise coverage by accepting exactly the
  answers this measurement cannot vouch for, so the thresholds stay.
- **The order check earns its place.** 3.4% of pairs were answered
  differently depending on the order the sides were shown in. Without the
  check, each of those would have been acted on whenever the first answer
  cleared its line.
- **Latency is not the constraint.** A request carries every question of
  its kind that fits its token budget, which for a sync is usually all of
  them, and its p95 is about half a second.

## What would reopen this

A measurement on a real brain's merge history, rather than the fixture sets,
that shows supersedes being kept as duplicates often enough to matter. Rerun
`scripts/measure-sync-judge.ts` against those pairs, and change a threshold
only when precision at the new line stays at 100% there. A newer Jev model is
the same case: re-measure before moving a line.
