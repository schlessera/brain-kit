---
"@schlessera/brain": minor
---

New `brain hygiene` commands own the content-hygiene log, which the skill's prose used to carry:
- `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run]` refreshes the index and detects issues: `brain audit`'s checks, every silent edit (without briefing's 10-row cap) and index table rows older than their detail files. It gives each issue its stable `{category}-{shortpath}-{hash4}` ID, applies the open/snoozed/resolved state machine to `context/hygiene/` and writes only the files that change, so a run that changes nothing leaves no diff. It keeps the parts of the log it does not own, replaces each file atomically, never drops an entry when a write fails part-way, and resolves nothing it did not see again while a check cannot run (a module's check throws, or fact-drift cannot read a canonical file). `--fixed` records the skill's auto-fixes in `last-run.md`.
- `brain hygiene list [--state …]` reads the log.

The `content-hygiene` skill now calls these instead of computing IDs with `sha1sum` and parsing `brain briefing` text. `brain audit` gains `exclude` and `onCheckFailed` options in the library; reconcile uses them to keep the log out of its own detection (its links and module findings included) and to learn which module checks failed.
