---
"@schlessera/brain": minor
---

`brain tags --apply` migrates frontmatter tags to their canonical forms. It applies every `taxonomy.tags.aliases` entry and every variant group whose canonical tag is in the vocabulary. `--groups` applies all groups, `--redundant` also drops tags that repeat the document's type or directory, and `--only <old>` limits the run to one tag. `--dry-run` reports without writing. It edits only the `tags:` entries on the raw text, so comments, quoting, key order and the rest of the file stay byte for byte, and `updated` is not bumped. The touched files are reindexed and their mtimes accepted, so briefing does not list them as silently modified. Files whose frontmatter does not parse are skipped and reported.
