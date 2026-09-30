---
name: brain-module
description: Use when turning a workflow domain on or off — jobs, speaking, travel, finance, or a locally authored module — or when a module's directories, taxonomy types, and skills should start or stop appearing.
compatibility: Requires git.
---

# Brain Module — Enable / Disable Domains

Turns workflow modules on and off. Config is the state, so this is idempotent by construction:
enabling adds structure, disabling flips a flag and leaves all content in place.

**This skill orchestrates; the CLI reports and validates.** The agent edits config and scaffolds
directories; `brain module` and `brain validate` do the deterministic parts.

## List what's available

```bash
brain module list
```

Show each available module with its one-liner (e.g. "jobs — scrape, score, and track job
opportunities"; "speaking — talks and conferences"; "travel — journeys, day trips and visited places";
"finance — client ledgers and accounts-receivable"). Mark which are already enabled.

## Enable a module

1. Add the module's entry to the `modules` block in `brain.config.ts`, filling any required
   config fields from a short interview (e.g. finance: which directory holds client ledgers).
2. Create the directories the module owns, each with an `_index.md` (type `index`): purpose
   blurb + empty registry table.
3. Regenerate the affected `<!-- brain:generated:{section} -->` regions of CLAUDE.md so the new
   directories and conventions are documented. Leave everything outside the markers untouched.
4. Validate and re-link skills:
   ```bash
   brain validate
   brain skills sync
   ```
5. Commit the change:
   ```bash
   git add -A && git commit -m "brain-module: enable <name>"
   ```

Tell the user that if they self-host, the container's cron picks up the module's scheduled jobs
on the next deploy — nothing to wire by hand.

## Disable a module

Flip its entry off in `brain.config.ts` (or remove the entry). **Never delete the module's
content** — the directories and documents stay exactly as they are, just no longer driven by the
module. Regenerate the CLAUDE.md marked sections to drop the module's conventions, run
`brain validate` and `brain skills sync`, and commit. Re-enabling later restores the workflow
against the content that was left in place.

## Notes

- Because the config is the single source of truth, running enable twice is a no-op and running
  disable never loses data.
- A module contributes its own types, directory anchors, and hygiene checks; after enabling,
  those types are valid targets for `brain add` and appear in audits automatically.

## CLI it relies on

- `brain module list` — available and enabled modules with one-liners.
- `brain validate` — confirm the config and structure are consistent.
- `brain skills sync` — pick up the module's skills.
- `git` — commit the enable/disable.
