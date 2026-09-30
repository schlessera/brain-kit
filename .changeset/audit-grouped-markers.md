---
"@schlessera/brain": minor
---

**Breaking (pre-1.0, ruled on #394):** `brain audit` reports TODO and VERIFY markers as one finding per document and kind instead of one per marker, and a `verify` finding is `info` instead of `warning`. Each carries `count` (the markers of that kind in the document) and `examples` (the first three, in source order). A document with both kinds has two findings. A consumer that counted `todo` or `verify` issues to count markers should sum `count`; one that treated `verify` as must-fix should read it as informational. `brain hygiene` keys `todo` and `verify` entries on the document, so an existing log resolves its per-marker entries once and opens one entry per document and kind.

Additive:

- The optional frontmatter `verification: unverified` declares a whole document unverified: exactly one `verify` finding, inline markers or not. There is no `verified` value, and a document without the field is not thereby verified. `brain validate` warns on any other value.
- A `broken-link` warning for each wiki-link that resolves to nothing, resolved exactly as `brain validate` resolves it (paths, basenames, directory anchors, `#heading`, `|label`, aliases) and worded the same, with the target in `target`.
- `brain audit --json` gains `mustFix` (errors plus warnings) and `informational` (infos). `brain maintain`'s audit step appends `; <n> must-fix, <n> informational` to its counts.

**Schema 15.** `brain.db` gains the nullable `documents.verification` column; the next `brain index` fills it.
