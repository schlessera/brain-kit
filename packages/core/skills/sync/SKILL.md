---
name: sync
description: Sync the local brain with its remote when asked to sync, commit, push, or pull — smart semantic commits, knowledge-aware conflict resolution, and a reindex, so no knowledge is ever lost.
disable-model-invocation: true
requires: [git]
---

# Sync — Knowledge-Aware Brain Synchronization

Commits local changes in semantic groups, pulls, resolves conflicts as *knowledge* rather than
code, pushes, and reindexes. Brain files are knowledge — every piece of information matters, so
conflict resolution never silently drops content.

**This skill orchestrates; `brain sync` does the mechanical git plumbing.** The agent handles
commit messages and conflict resolution; the CLI handles staging, pulling, pushing, and the
post-sync reindex. Run all five phases in order and report progress at each boundary.

## Phase 1 — Assess & clean

```bash
brain sync assess
```

Outputs `STATUS\tCLASS\tPATH` for every changed/untracked file. Handle each class:

- **TRACK** — commit it in Phase 2.
- **ARTIFACT** — delete if useless (`*.pyc`, `__pycache__/`, `*.swp`); add to `.gitignore` if the
  pattern may recur and isn't covered. If `.gitignore` changed, stage and commit it first.
- **SENSITIVE** — ensure it's gitignored; if not, add it to `.gitignore`, commit, and warn the user.
- **UNKNOWN** — read the file. Generated output / test fixture / temp data → treat as ARTIFACT;
  otherwise TRACK.

If assess reports "No local changes", skip to Phase 3.

## Phase 2 — Smart commits

```bash
brain sync group
```

Outputs `DOMAIN\tSTATUS\tPATH` sorted by domain. For each domain group:

1. **Update frontmatter** — for each modified `.md` file, if `updated` isn't today's date, set it
   to today. Do not touch `updated` for deleted or non-markdown files.
2. **Stage** — `git add <files>`.
3. **Craft the message** — imperative mood ("Update", "Add", "Fix"); first line under 72 chars;
   body explaining what and why when needed; end with the standard co-author line for the agent
   currently running (the one the environment specifies — never hardcode a model name here).
4. **Commit** with a HEREDOC so the body and co-author line are preserved.

Bundling: single-file domains bundle with a related domain; config changes bundle with the most
related domain; never exceed ~10 files per commit; one domain → one commit.

## Phase 3 — Pull & merge

```bash
brain sync pull
```

- `STATUS=synced` / `fast-forwarded` / `merged` → skip to Phase 5.
- `STATUS=conflicted` → Phase 4.
- `STATUS=fetch-failed` → warn the user (network?) and stop.

## Phase 4 — Knowledge-aware conflict resolution

This phase is rare but critical. Standard git merge treats files as code; brain files are
knowledge.

```bash
brain sync conflicts
```

Outputs BASE, OURS, and THEIRS for each conflicted file. Pick a strategy by what the file *is*
(use the effective taxonomy, not hardcoded paths):

| File kind | Strategy |
|---|---|
| any `_index.md` / registry table | **table-union** |
| module status doc with a `## Timeline` | **timeline-append** |
| the canonical current-focus document | **synthesize** |
| inbox notes | **keep-both** |
| identity / expertise-style stable prose | **latest-wins-additive** |
| `CLAUDE.md`, code and config (`*.ts`, `*.sh`) | **code-merge** |
| sidecar caches (`.context-cache.jsonl`, `.asset-cache.jsonl`) | **cache-union** |
| any other `.md` | **synthesize** |

**table-union** — union all rows from OURS and THEIRS; for same-key rows keep the latest `Updated`
and most-advanced status; preserve OURS' header/alignment; sort as before.
**timeline-append** — the timeline is append-only: merge all entries by date, drop exact
duplicates, keep both when the same date has differing text; union any tables by key; frontmatter
takes latest `updated`, most-advanced `status`.
**synthesize** — keep every unique fact/bullet from both sides; when both changed the same item,
keep both (more recent first) unless one clearly supersedes; never silently drop information.
**keep-both** — if BASE differs from both, keep OURS in place and save THEIRS as
`{filename}-remote.md`; if only one side changed, take that side.
**latest-wins-additive** — take the latest-`updated` version of stable sections, but include any
section either side added that the other lacks.
**cache-union** — these JSONL sidecars are rebuilt from brain.db on the next `--embeddings` index;
union lines by their `k` key (keep OURS on collision), sort, write. Never hand-merge hunks.
**code-merge** — compare BASE→OURS and BASE→THEIRS; combine non-overlapping changes; use
engineering judgment when they conflict semantically.

**Universal frontmatter rules (all `.md`):** `updated` = latest; `tags` = union, sorted,
deduped; `created` = earliest; other fields = OURS plus any field only THEIRS has.

For each resolved file: write the merged content, then `git add <file>`. When all are resolved,
`git commit --no-edit`.

## Phase 5 — Push & report

```bash
brain sync push
```

If `STATUS=rejected` (remote moved during sync), go back to Phase 3 — max 3 retries. Then:

```bash
brain sync post-sync
```

This rebuilds the search index with embeddings (`brain index --incremental --embeddings`); check
for `INDEX=ok` or `INDEX=failed`. Report tersely: commits created (one line each), conflicts
resolved (strategy + brief description each), index status, and final sync status.

## Notes

- Speed matters for the common case (no conflicts): Phases 1–3–5 should be fast; Phase 4 is where
  to slow down and read both versions carefully.
- **Never** use `git reset --hard`, `git checkout -- .`, or other destructive commands. If
  something goes wrong, stop and tell the user.
- Flag binary files or files >100KB to the user rather than attempting a merge.
- `updated` reflects when content last meaningfully changed, not when the sync ran — only bump it
  for files with real content changes, not merge artifacts.
- No local changes and no remote changes → report "Already in sync" and stop; no empty commits.
- The underlying `brain sync` subcommands also run standalone: without an agent they still provide
  assessment and grouping, but the knowledge-aware conflict resolution needs an agent.

## CLI it relies on

- `brain sync assess|group|pull|conflicts|push|post-sync` — mechanical git operations + reindex.
- `brain index --incremental --embeddings` — invoked by `post-sync`.
- `git` — staging, HEREDOC commits, and `git commit --no-edit` after conflict resolution.
