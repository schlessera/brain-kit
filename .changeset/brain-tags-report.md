---
"@schlessera/brain": minor
---

New `brain tags` command: a read-only report of tag hygiene, read from frontmatter. It lists variant groups such as `trail`/`trails` or `wood-working`/`woodworking`, each with a proposed canonical tag. It also lists tags that repeat a document's type or directory, documents still carrying an aliased tag, and tags outside your vocabulary. A new optional `taxonomy.tags` config block (`vocabulary`, `aliases`, `redundant`, `inflection`) steers the report, and `brain validate` now warns on an aliased or out-of-vocabulary tag when the block is set. `brain maintain` gains a `tags` step that prints the counts only and never fails the run.
