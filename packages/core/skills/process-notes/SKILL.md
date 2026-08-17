---
name: process-notes
description: Use when the capture inbox needs clearing — deciding for each unfiled note whether it belongs somewhere in the taxonomy, should be merged into a document that already covers it, or should be archived.
requires: [git]
---

# Process Notes — Clear the Inbox

Works through the capture inbox and gives each note a proper home. Quick capture is deliberately
lossy about placement; this skill is where notes become filed, enriched brain content.

**This skill orchestrates; the CLI moves and validates.** The agent decides where each note
belongs; `brain process` / `brain add` / `brain archive` execute the move.

## 1. List the inbox

```bash
brain list --type note --status active --json
```

These are unprocessed inbox items (`notes/`, `status: active`). Work through them oldest first.

## 2. Decide per note

For each note, read it and pick one disposition:

- **File into the taxonomy** — it's a real piece of content that belongs under an existing type
  (a project update, an expertise note, an opinion). Assimilate it:
  ```bash
  brain process notes/<file>.md
  ```
  `brain process` routes it to the right directory, upgrades the frontmatter, and removes the
  original inbox note (pass `--keep-note` to retain it). Use `--all` only when the whole inbox is
  homogeneous enough to batch.
- **Merge into existing content** — it's an update to something that already exists. Append it to
  the matching document (reuse its title, see `/add`) rather than creating a duplicate, then
  delete the inbox note.
- **Enrich, then file** — it's worth keeping but thin. Add the missing frontmatter, a one-line
  `summary`, and tags, then file it.
- **Archive** — captured, no longer actionable, but worth keeping as history:
  ```bash
  brain archive notes/<file>.md
  ```
- **Drop** — pure noise (a stray keystroke, an accidental capture). Delete it. When unsure,
  archive instead of deleting.

## 3. Keep indexes in sync

Whenever a note lands in a directory, update that directory's `_index.md` registry table in the
**same operation** — this is the Index Sync Principle, and `brain audit` flags lag if you skip it.
If filing a note changes the current picture, update the current-focus document too.

## 4. Validate and commit

```bash
brain validate
git add -A && git commit -m "process-notes: file N inbox items"
```

Report a terse summary: how many filed, merged, enriched, archived, dropped.

## Notes

- Bias toward filing over deleting — the inbox is a staging area, not a trash can.
- One commit for the whole pass keeps history readable and the run revertable.

## CLI it relies on

- `brain list --type note --status active --json` — enumerate the inbox.
- `brain process <path> [--keep-note] [--all]` — assimilate a note into the taxonomy.
- `brain add` — append updates to existing documents.
- `brain archive <path>` — retire a note as history.
- `brain validate` — confirm consistency; `git` — commit the pass.
