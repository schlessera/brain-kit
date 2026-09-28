---
name: sync
description: Use when asked to sync, commit, push, or pull a brain, and for scheduled or unattended synchronization. Also use when an earlier sync left conflicts, a dirty working tree, or a stalled merge behind.
disable-model-invocation: true
compatibility: Requires git.
---

# Sync — Knowledge-Aware Brain Synchronization

`brain sync run` does the whole sync without you: it cleans and commits local changes, pulls,
merges conflicted notes by rule, pushes, and reindexes. **You handle only what it hands back:**
a conflict no rule can merge, a file it could not classify, and media nobody has approved.
Brain files are knowledge, so nothing here may silently drop content.

## Autonomy — no plans, no approval

A sync is frequently unattended: on a schedule, from a container, or through an agent runner with
nobody watching. It must therefore complete on its own, and these rules override any default
cautiousness. They hold in an interactive session too — every decision below has a defined
conservative default, so there is nothing worth stopping to ask about. **The one exception is
a media decision** (a `MEDIA` or `LARGE` leftover): committing a binary is permanent in git's
history, so it is never a default. Interactively, ask; unattended, leave it untouched and report
it.

- **Never stop to plan.** Do not enter a plan-and-approve mode, write a plan document, or present
  a plan and wait for a go. There may be nobody to approve it — a sync that ends with "awaiting
  approval" is a failed sync.
- **Never ask questions**, except the media decision above. No interactive prompts, no "should I…"
  in the output. Take the default, and note what was decided in the final report.
- **Conservative default everywhere:** when two resolution options exist, pick the one that keeps
  more content (union / keep-both over overwrite) and touches less state. Never delete, reset, or
  rewrite history to make a problem go away.
- **Truly unresolvable items** (binary conflicts, files over 100 KB, a stash entry `run` kept)
  and **media nobody has approved** are the only allowed leftovers: leave them untouched and list
  them in the final report. The only reasons to stop early are the ones `run` reports as `failed`.

## Step 1 — Run it

```bash
brain sync run --json
```

It prints one envelope: `{ status, reason?, steps, leftovers: { unresolved, unknown, media },
judge, timings, report }`. Use the JSON form: bare `brain sync` prints only the text report.

- `status: "complete"` (exit 0) — pushed and reindexed. If `leftovers.unknown` and
  `leftovers.media` are both empty, print `report` and stop. Otherwise go to Step 3.
- `status: "needs-judgment"` (exit 3) — a conflict no rule could merge. The merge is still in
  progress and nothing was pushed. Go to Step 2.
- `status: "failed"` (exit 1) — a fetch failed, git would not merge, or the push was rejected
  three times; `reason` says which. Print `report`, run `git status` to show what blocks it, and stop. Do not retry,
  and do not commit, stash, abort or discard anything for the user.

What `run` already did, so you do not redo it: reconciled stash entries (dropped the ones the
tree already contains, popped clean autostashes), ignored artifacts and secrets in one
`.gitignore` commit, bumped `updated` on edited notes, committed tracked changes grouped by
domain, pulled (unioning the derived caches and finishing any merge an earlier sync left
behind), merged every conflicted note by the strategy table below, pushed, and ran
`post-sync`. Each key under `steps` (`stash`, `assess`, `commit`, `pull`, `resolve`, `conclude`,
`push`, `postSync`) is an array of that verb's envelopes in run order, since a step can run
more than once. When a merge was pending at the start, `steps.assess[0]` is only
`{ skipped: "…" }`: the pull finished that merge first, and local work was committed after it.
A push with nothing to send is `{ status: "up-to-date" }`.

## Step 2 — Conflicts `run` could not merge

`leftovers.unresolved` lists each one as `{ path, strategy, reason }`. The reason says why:
`code-merge` (code, config, `CLAUDE.md`, `AGENTS.md`), a binary side, a side over 100 KB, or
markdown that does not parse. Every other conflicted file is already merged and staged.

```bash
brain sync conflicts --json
```

This prints BASE, OURS and THEIRS for every file still unmerged. For each one:

- **code-merge** — compare BASE→OURS and BASE→THEIRS, combine the changes that do not overlap,
  and use engineering judgment where they conflict in meaning. Write the result.
- **markdown that did not parse** — merge it by hand with the strategy its `strategy` field
  names (table below). Keep every fact from both sides.
- **binary or over 100 KB** — do not merge it. Leave it unmerged, report it, and stop: the
  push waits for a human.

Then `git add <file>` for each file you wrote, and finish the merge:

```bash
brain sync conclude --json
```

`outcome: "committed"` concludes a merge; `outcome: "unstaged"` means the conflict came from a
stash pop, whose resolution is now an ordinary working-tree change. Either way, go back to
Step 1 and run `brain sync run --json` again: it commits what is left, pushes and reindexes.
`outcome: "unresolved"` means a path is still unmerged — resolve it first.

## Step 3 — Leftover files

**UNKNOWN** (`leftovers.unknown`) — a file `assess` could not classify, and that the Jev judge
(when `TYPESAFE_API_KEY` is set) did not decide with enough confidence. Read it.

- Generated output, an export, a scratch log, test data → it is an artifact. Append its exact
  path to `.gitignore` and commit `.gitignore` alone:
  `git commit --only -m "Ignore generated artifacts and secrets" -- .gitignore`.
  Never delete the file.
- Something the owner wrote or deliberately kept → commit it:
  `git commit --only -m "Add <domain>: <title>" -- <path>`.

**MEDIA / LARGE** (`leftovers.media`, each with its `bytes`) — a binary (image, PDF, audio,
video, office file) or any file over `media.maxTrackedBytes`. Git keeps every version forever.

- **Someone is there:** ask before tracking it, and name the size. Offer three answers:
  track it (small final media a note uses), ignore it (iterations, renders, exports — add a
  `media.ignore` glob in `brain.config.ts` or a `.gitignore` line so the question does not
  come back), or keep it with Git LFS (large masters that must travel with the brain).
- **Unattended:** leave it untouched (not staged, not deleted, not ignored) and list it with its
  size in the final report as awaiting a decision.
- A `media.track` glob records a standing "track", and a `media.ignore` glob a standing
  "ignore"; files they match never come back as MEDIA or LARGE.

If you committed anything in this step, run `brain sync run --json` once more to push it and
reindex.

## Commit messages

`run` writes commit messages from a template: `<Verb> <domain>: <title>, <title> (+N more)`,
with one `- <status> <path>` line per file in the body. That is always acceptable. When there
are local changes and you want messages that say why, do this **before Step 1**, so the changes
are committed with your messages and `run` finds nothing left to commit:

```bash
plan="$(mktemp)"                           # outside the brain, so it is never committed
brain sync commit --plan > "$plan"          # prints the plan as JSON; changes nothing
# edit the subject and body of each commit in "$plan"
brain sync commit --plan-file "$plan"       # applies it; files are re-checked
```

The plan's files are re-validated against what `assess` classes as TRACK, so a plan cannot
commit a file the sync would not. Keep the grouping; change only the messages.

## How `run` merged each conflict

Report each resolution from `steps.resolve[].resolved[]`: its `path`, its `strategy`, and its
`notes` — one line per choice that was not a plain three-way merge. `extraFiles` names a
`-remote.md` copy keep-both wrote, and `deleted` says the merge removed the file. The derived
caches appear under `skipped`, because `pull` already merged them. `decisions` counts how many
passage choices Jev made and how many took the default. The strategy comes from what the file
*is*, first match wins:

| File kind | Strategy |
|---|---|
| sidecar caches (`.context-cache.jsonl`, `.asset-cache.jsonl`) | **cache-union** (done by `pull`) |
| not markdown, or `CLAUDE.md` / `AGENTS.md` | **code-merge** (left to you) |
| a type with `mergeStrategy` in the taxonomy | that strategy |
| any `_index.md` | **table-union** |
| a document with a `Timeline` heading | **timeline-append** |
| any other `.md` | **synthesize** |

The core types set their own: `identity` is **latest-wins-additive**, `note` (the inbox) is
**keep-both**, `index` is **table-union**.

**Frontmatter (all `.md`):** a field only one side changed takes that side. Both changed:
`updated` = latest, `created` = earliest, `tags` = union, sorted, deduped, `status` = THEIRS when
OURS left it alone, anything else = OURS. A field only one side added is kept.
**synthesize** — sections and blocks merge three-way; a section either side added is kept. A
passage both sides changed is a judgment: Jev may call it the same fact (keep ours) or one side a
correction of the other (keep that side); otherwise both are kept, newer first. The output is
always verbatim blocks from the two sides, never new text.
**table-union** — rows keyed by their first cell; a row both sides changed goes to its later
`Updated` date, else to a judgment as above. OURS' header, OURS' rows in order, then THEIRS' new
rows.
**timeline-append** — timeline entries merged by date, exact duplicates dropped, both kept when
the same date has differing text; other sections as synthesize.
**keep-both** — if BASE differs from both, OURS stays in place and THEIRS is saved beside it as
`<name>-remote.md`; if only one side changed, that side.
**latest-wins-additive** — per section, the side with the later `updated`, plus any section
either side added.

## Report

Report tersely, from `report` and what you did after it: commits created (one line each),
conflicts resolved (strategy and a short description each, and which ones you merged by hand),
index status, final sync status, and every leftover with its reason.

## Notes

- **Never** use `git reset --hard`, `git checkout -- .`, `git stash clear`, or other destructive
  commands. If something goes wrong, stop and tell the user.
- A sync with nothing to do reports "Already in sync"; it makes no empty commits.
- `updated` reflects when content last meaningfully changed: `run` bumps it only for edited
  notes whose body changed, never for merge results. Do not bump it by hand for a merge.
- `brain sync` with no verb runs `brain sync run` itself, prints its report, and starts this
  skill only when the run needs judgment, left unknown files, or left media with a terminal
  attached. You may therefore find local changes already committed and a merge already in
  progress; Step 1 picks up from there.

## CLI it relies on

- `brain sync run` — the whole sync, deterministically. Its steps also run on their own:
  `assess [--fix]`, `commit [--plan | --plan-file <path>]`, `stash [--dry-run]`, `pull`,
  `resolve`, `conclude`, `push`, `post-sync`.
- `brain sync conflicts` — BASE, OURS and THEIRS for each file still unmerged.
- `git` — `git add` after a hand merge, and `git commit --only` for a leftover you decided.
