---
"@schlessera/brain": minor
---

New `brain hygiene` commands own the content-hygiene log, which the skill's prose used to carry:
- `brain hygiene reconcile [--extra <file.json>] [--dry-run]` refreshes the index and detects issues: `brain audit`'s checks, every silent edit (without briefing's 10-row cap) and index table rows older than their detail files. It gives each issue its stable `{category}-{shortpath}-{hash4}` ID, applies the open/snoozed/resolved state machine to `context/hygiene/` and writes only the files that change, so a run that changes nothing leaves no diff.
- `brain hygiene list [--state …]` reads the log.

The `content-hygiene` skill now calls these instead of computing IDs with `sha1sum` and parsing `brain briefing` text. `brain audit` gains an `exclude` option in the library, which reconcile uses to keep the log out of its own detection.
