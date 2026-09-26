---
name: content-hygiene
description: Use for a recurring sweep over a brain's content, including scheduled and unattended runs — checking for stale, contradictory, or silently edited documents. Safe to run repeatedly — it fixes only what is mechanically certain and logs the rest as deduplicated issues for a human to judge.
---

# Content Hygiene

Systematic, idempotent scan over the brain. Detects stale and conflicting content, auto-fixes
only when the truth is mechanically clear, and logs everything else into `context/hygiene/` with
stable IDs so re-runs never duplicate and never drift.

**This skill orchestrates; the CLI detects and keeps the log.** `brain hygiene reconcile` refreshes
the index, runs every mechanical detection (`brain audit`'s checks, silent edits, the index table
diff), gives each issue its stable ID, applies the open/snoozed/resolved state machine and writes
`context/hygiene/` without churn. The agent does what needs judgment: canonical conflicts, and
which auto-fixes to apply.

## Input

None. Optional flag in the user message: `--dry-run` (detect and report; no brain content is
written: no fixes, and nothing under `context/hygiene/`. The index is still refreshed, and the
candidate file goes to the scratch area, `.brain/scratch/`, as on any run).

Work the phases in order. Be conservative: if a fix is not clearly warranted, log it instead.

## Phase 1 — Detect

```bash
brain hygiene reconcile --dry-run --json
brain hygiene list --json
```

The first refreshes the index and reports every mechanically detected issue under `detected`
(`id`, `category`, `path`, `message`), writing no log file. The second is the log as it stands, by
state. If either fails, stop and report.

## Phase 2 — Canonical-source conflicts

Read the canonical files and propagation rules **from config** — do not hardcode paths:

```bash
brain config check
```

Use `taxonomy.canonical` (e.g. `identity`, `currentFocus`) as the canonical anchors and
`taxonomy.propagation` (source → derivative globs) for derivation drift. **If a canonical entry is
unset, skip that check** — a fresh brain may declare none, and that is normal, not an error.

**Keyed facts are checked by the CLI.** For every fact in `taxonomy.facts`, `brain audit --json`
already reports each document that restates it with another value, as a `fact-drift` issue
(`message: "<key>: found <x>, canonical <y>"`). Take those issues as they are: log each one, do not
re-derive them, and do not rewrite the text. A historical piece that is right to state an old value
lists the key under `facts_ignore:` in its frontmatter.

The judgment pass below is only for canonical files whose frontmatter has **no** `facts:` map.
For each such file:
1. Extract short structured anchor facts: dates (`YYYY-MM-DD` or `Month YYYY`), role/title strings,
   named statuses, employer/organization names.
2. Search secondary files (all `.md` outside the inbox, archived content, and `context/hygiene/`)
   for the same subject with a diverging value.
3. Only emit a `conflict` when: the diverging text is a short structured fact (not prose), both
   files cover the same subject, and the canonical was updated **after** the secondary file.

Be conservative: when the recency gap is small (<7 days) or the texts are paraphrases rather than
contradictions, log nothing.

Collect each conflict as a candidate for Phase 4:
`{ "category": "conflict", "path": "<the secondary file>", "evidence": "<the canonical fact text>",
"message": "<what diverges, and from which canonical file>" }`.

## Phase 3 — Apply moderate auto-fixes

For each detected issue and conflict, decide auto-fix vs. log. An `index-lag` issue from the
table diff names the row, its values and the detail file's in its message. **Skip any file that
is:** in the inbox directory, under archived content, inside `context/hygiene/`, or has frontmatter
`status: archived`.

**Auto-fix (edit the file directly, and keep a list of what you fixed, one `{ "path", "fix" }`
per fix, for Phase 4):**

1. **`updated < created`** — set both fields to the later of (created, updated, file mtime as a
   date). Bump `updated` only if the chosen date is newer than the current `updated`.
2. **Index-lag, single-column disagreement** — if the only divergence between a row and its newer
   detail file is `Status`, update the row's `Status` and `Updated` to match the detail file's
   frontmatter. Bump the `_index.md` `updated` only if the row actually changed.
3. **Canonical conflict, gap >30 days, structured fact** — replace the contradicting fragment in
   the older file with the canonical version verbatim; bump that file's `updated` to today. Only
   when the diverging text is ≤2 lines and the canonical text is obviously substitutable in
   context. If unsure: log instead.

**Log-only (never auto-fix):** staleness past threshold, TODO/VERIFY markers, propagation/derivative
drift, `fact-drift` from `brain audit` (never rewrite the restated value), silent edits, orphans, type/directory mismatches, conflicts with no canonical or a recency
gap <30 days, and anything ambiguous.

With `--dry-run`, apply none.

## Phase 4 — Record the log

First drop from the Phase 2 conflicts every one a Phase 3 fix cleared, and any other that no
longer holds when you re-read both files: the CLI cannot detect a conflict itself, so a conflict
it is handed stays open. Then write two JSON arrays (`[]` when empty):

- `.brain/scratch/hygiene-extra.json`: the conflicts still present.
- `.brain/scratch/hygiene-fixed.json`: the Phase 3 fixes, e.g.
  `[{ "path": "work/_index.md", "fix": "Alpha row status active → paused" }]`.

```bash
brain hygiene reconcile --extra .brain/scratch/hygiene-extra.json \
  --fixed .brain/scratch/hygiene-fixed.json --json
```

With `--dry-run`, there are no fixes: pass `--dry-run` and leave out `--fixed`. It computes the
same and writes no log file.

This detects again, so issues your fixes cleared are resolved, and then matches everything
against the log by ID:

| Existing state | Detected now? | Action |
|---|---|---|
| (none) | yes | add to open |
| open | yes | update last seen, keep in open |
| open | no | move to resolved (`resolved-by: auto-disappeared`) |
| snoozed (until > today) | either | leave snoozed |
| snoozed (until ≤ today) | yes | move back to open |
| snoozed (until ≤ today) | no | move to resolved (`auto-disappeared`) |
| resolved | yes | re-open (`reopened: today (was resolved-by: <prev>)`) |
| resolved | no | leave resolved |

It writes a file only when its content changes, and `last-run.md` only when an issue changed
state or `--fixed` names a fix (it lists them under "Auto-fixes applied this run"), so a run that
changes nothing leaves no diff. It keeps `resolved.md` to the newest 200 entries, and any section
of the log it does not own (your own notes) as written. The log's own files are never detected as
issues. If a check cannot run (a module's check throws, or `fact-drift` cannot read a canonical
file), `failedChecks` names it and no entry is resolved unless it was detected again; report it. If a log file cannot be parsed safely (its
frontmatter is broken, say), reconcile exits non-zero and writes nothing: stop and report.

**Stable IDs** are `{category}-{shortpath}-{hash4}`: `shortpath` is the last two path segments,
extension dropped, lowercased, with every run of characters outside `a-z0-9_-` (`/` and `.`
included) turned into one `-`; `hash4` is the first 4 hex characters of a SHA-1 over
`{category}|{path}|{evidence}`. The evidence is the smallest stable piece for the category:
staleness → the document's type; conflict → the canonical fact text you gave; index-lag → the
row's first cell (the whole-file audit finding: the index path); propagation, silent-edit,
orphan and stale-draft → the file path; todo/verify → the marker text; type-mismatch → the type
name; budget → the canonical key; past-date → the date and the line's text; fact-drift →
`{key}={found}`, so the ID holds while the document keeps the same wrong value; repeated-text →
the paragraph's excerpt; module-hygiene → the module's name; review-overdue and tag-noise →
empty; any other category (a module's) → its message.

## Phase 5 — Report

Print a terse summary from the Phase 4 output and your fixes:

```
content-hygiene complete
  auto-fixed: N   new open: {opened}   reopened: {reopened}
  resolved: {resolved} (auto-disappeared)   still open: {stillOpen}   snoozed: {snoozed}
```

If nothing changed (`changedFiles` empty and no fixes), print one line:
`content-hygiene: no changes (N issues still open)`. If `--dry-run`, prefix `[DRY-RUN]` and add
`(no content written)`.

## Notes

- **Conservative by default** — when ambiguous, log instead of fix.
- **Derivative regeneration is never automated** — propagation/derivative drift is logged only.
- **No interactive prompts** — runs to completion without user input, so it can be scheduled.
- **Respects manual moves** — if the user moves an issue between files or edits `until:` dates by
  hand, `brain hygiene reconcile` matches by ID and keeps those decisions.
- **`updated` discipline** — bumped only on files whose content actually changed; the skill must
  not churn timestamps just by running.
- **Failure mode** — if any command fails (e.g. `brain hygiene reconcile` exits non-zero), stop and
  report; never write partial state.
- The interactive `brain audit --fix` suggestion flow is separate and is **not** invoked here.

## CLI it relies on

- `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run] --json` —
  refresh the index, detect, and reconcile the log.
- `brain hygiene list [--state open|snoozed|resolved] --json` — the log as it stands.
- `brain config check` — read `taxonomy.canonical` and `taxonomy.propagation`.
