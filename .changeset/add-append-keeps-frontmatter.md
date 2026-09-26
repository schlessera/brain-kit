---
"@schlessera/brain": patch
---

When `brain add` appends to an existing document, it now changes only `updated` in the frontmatter and adds the dated `## <date> Update` section. Every other frontmatter byte stays as written. Before, the append re-serialized the whole frontmatter: YAML comments were dropped, optional quotes stripped and lists restyled. It now goes through the same raw-text editor that archiving and `brain_update` use.
