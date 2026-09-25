---
name: content-hygiene
description: Use for a recurring sweep over a brain's content, including scheduled and unattended runs — checking for stale, contradictory, or silently edited documents. Safe to run repeatedly — it fixes only what is mechanically certain and logs the rest as deduplicated issues for a human to judge.
compatibility: Requires either sha1sum (GNU coreutils) or shasum (macOS and BSD) for the stable issue IDs.
---

# Content Hygiene

Systematic, idempotent scan over the brain. Detects stale and conflicting content, auto-fixes
only when the truth is mechanically clear, and logs everything else into `context/hygiene/` with
stable IDs so re-runs never duplicate and never drift.

**This skill orchestrates; `brain audit`/`brain briefing` detect.** The agent applies conservative
fixes and maintains the issue log — it does not re-implement detection.

## Input

None. Optional flag in the user message: `--dry-run` (detect and report, no writes anywhere — not
even to `context/hygiene/`).

Work the phases in order. Be conservative: if a fix is not clearly warranted, log it instead.

## Phase 1 — Refresh the index

```bash
brain index --incremental
```

Ensure brain.db reflects the current filesystem before any detection. If this fails, stop and report.

## Phase 2 — Gather existing detections

```bash
brain audit --json
brain briefing --json
```

`brain audit` already detects staleness (per each type's threshold), propagation drift, TODO/VERIFY
markers, type/directory mismatches, orphans, and frontmatter-date index lag (any `_index.md` whose
`updated` trails its newest detail file). Parse it into in-memory issue candidates. Where audit's
`index-lag` overlaps the table-row pass in Phase 4a, dedupe in favor of the more specific 4a finding.

`brain briefing` includes silently-modified files (filesystem mtime > frontmatter `updated`). Treat
drift beyond 7 days as a `silent-edit` candidate.

## Phase 3 — Load prior hygiene state

Read the existing hygiene files (create them from the templates in Phase 7 if absent):

- `context/hygiene/open.md`
- `context/hygiene/snoozed.md`
- `context/hygiene/resolved.md`

Parse each entry. An entry looks like:

```markdown
### staleness-context-current-focus-a7f3
- **Files**: `context/current-focus.md` (updated 2026-05-01)
- **Issue**: Last updated 40 days ago (threshold: 30 days)
- **First seen**: 2026-05-15 · **Last seen**: 2026-06-01
```

Build an in-memory map: `id → { state: open|snoozed|resolved, last_seen, until, resolved_on, resolved_by }`.

## Phase 4 — Run the detection passes

### 4a. Index-vs-detail lag

Enumerate index documents and diff each registry table against its detail files:

```bash
brain list --type index --json
```

For each `_index.md` with a pipeline-style table (rows linking to per-item detail files or dirs):
1. Parse the table; identify the `Status` and `Updated` columns by header text (names vary).
2. For each row, follow the link to the detail file and read its frontmatter.
3. If the detail file is newer than the row **and** their `status` or `updated` disagree, emit an
   `index-lag` issue with the row text plus the detail file's authoritative values.
4. Skip rows whose detail file is missing (already covered by audit's orphan/structural checks).

### 4b. Canonical-source conflicts

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

### 4c. Silent edits

Already gathered in Phase 2 from `brain briefing`. Filter to drift >7 days; emit a `silent-edit`
issue per file.

## Phase 5 — Apply moderate auto-fixes

For each candidate, decide auto-fix vs. log. **Skip any file that is:** in the inbox directory,
under archived content, inside `context/hygiene/`, or has frontmatter `status: archived`.

**Auto-fix (edit the file directly, record each in `last-run.md`):**

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
drift, silent edits, orphans, type/directory mismatches, conflicts with no canonical or a recency
gap <30 days, and anything ambiguous.

## Phase 6 — Reconcile against prior state

For each issue (new + carried over):

1. **Stable ID** = `{category}-{shortpath}-{hash4}` where `category` ∈ {staleness, conflict,
   index-lag, propagation, silent-edit, todo, verify, orphan, type-mismatch}; `shortpath` = the
   last two path segments of the primary file, slugified (`/` and `.` → `-`, lowercase, no
   extension); and `hash4` = the first 4 hex chars of a SHA-1 over `{category}|{path}|{evidence}`.
   The `evidence` snippet is the smallest stable piece of evidence for the category (staleness →
   threshold class name; conflict → the canonical fact text; index-lag → the row's first-column
   value; propagation → the derivative path; silent-edit/orphan → the file path; todo/verify → the
   marker text; type-mismatch → the type name). Compute it deterministically, e.g. inline as
   `printf '%s' "$s" | { sha1sum 2>/dev/null || shasum; } | cut -c1-4`. GNU systems have
   `sha1sum`; macOS and the BSDs ship `shasum` instead, and both print the digest first, so the
   IDs match either way.

2. Apply the state machine:

   | Existing state | Detected now? | Action |
   |---|---|---|
   | (none) | yes | add to open |
   | open | yes | update `last-seen`, keep in open |
   | open | no | move to resolved (`resolved-by: auto-disappeared`) |
   | snoozed (until > today) | either | leave snoozed |
   | snoozed (until ≤ today) | yes | move back to open |
   | snoozed (until ≤ today) | no | move to resolved (`auto-disappeared`) |
   | resolved | yes | re-open with `reopened: today (was resolved-by: <prev>)` |
   | resolved | no | leave resolved |

3. Issues cleared by Phase 5 fixes will simply not be detected this run and fall to resolved via
   the "open → no detection → resolved" path.

## Phase 7 — Write the hygiene files

Templates for first-time creation live in `templates/` next to this SKILL.md. Read the matching
template and use its body verbatim when a file is missing, substituting `<TODAY>` (and `<TIMESTAMP>`
in `last-run.md`):

| Target | Template |
|---|---|
| `context/hygiene/_index.md` | `templates/_index.md` |
| `context/hygiene/open.md` | `templates/open.md` |
| `context/hygiene/snoozed.md` | `templates/snoozed.md` |
| `context/hygiene/resolved.md` | `templates/resolved.md` |
| `context/hygiene/last-run.md` | `templates/last-run.md` |

**Write policy (the idempotency core).** For `open.md`, `snoozed.md`, `resolved.md`, `_index.md`:
compute the new content, read the existing file, and **if the body below the frontmatter is
byte-identical, do not write** (do not bump `updated`). Only rewrite — and set `updated` to today —
when the body actually changed. For `last-run.md`: write only if state changed (a fix applied, an
issue moved, appeared, or disappeared); on a true no-op run, leave it alone. This preserves the
"zero git diffs on a no-op heartbeat" invariant. Cap `resolved.md` at 200 entries, dropping the
oldest by `resolved-on`.

## Phase 8 — Report

Print a terse summary:

```
content-hygiene complete
  auto-fixed: N   new open: M   reopened: R
  resolved: K (auto-disappeared)   still open: O   snoozed: S
```

If nothing changed and `still open` is unchanged, print one line:
`content-hygiene: no changes (N issues still open)`. If `--dry-run`, prefix `[DRY-RUN]` and add
`(no writes performed)`.

## Notes

- **Conservative by default** — when ambiguous, log instead of fix.
- **Derivative regeneration is never automated** — propagation/derivative drift is logged only.
- **No interactive prompts** — runs to completion without user input, so it can be scheduled.
- **Respects manual moves** — if the user moves an issue between files or edits `until:` dates by
  hand, matching is by ID and those decisions are preserved.
- **`updated` discipline** — bumped only on files whose content actually changed; the skill must
  not churn timestamps just by running.
- **Failure mode** — if any command fails (e.g. `brain index` errors), stop and report; never write
  partial state.
- The interactive `brain audit --fix` suggestion flow is separate and is **not** invoked here.

## CLI it relies on

- `brain index --incremental` — refresh the DB.
- `brain audit --json` — existing staleness/lag/propagation/orphan/mismatch detection.
- `brain briefing --json` — silent-edit data.
- `brain list --type index --json` — enumerate index documents for the lag pass.
- `brain config check` — read `taxonomy.canonical` and `taxonomy.propagation`.
- `sha1sum`, or `shasum` where that is what exists — deterministic stable-ID hashing.
