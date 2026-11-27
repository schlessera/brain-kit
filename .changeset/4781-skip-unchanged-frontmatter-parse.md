---
"@schlessera/brain": patch
---

A complete index run no longer parses the frontmatter of every markdown file to learn that nothing changed (#4781). Every file is still read and hashed, so any changed byte is still seen; a file whose hash and chunker version match its row, in a run that is not `--force` and rebuilds no full-text table, is no longer parsed. The titles and aliases of those unchanged files are read from the index instead, as targeted runs already do, so a change to how frontmatter is parsed reaches them through `brain index --force` or a schema step that clears `content_hash`. One difference follows from how aliases are stored, one per line: an alias that itself contains a line break is read back as two aliases, as it already was on targeted runs.
