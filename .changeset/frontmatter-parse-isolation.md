---
"@schlessera/brain": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-module-finance": patch
"@schlessera/brain-module-jobs": patch
---

Frontmatter parsing no longer goes through gray-matter's process-wide cache. Two byte-identical documents parsed in one process now get independent data, so changing one can no longer change what is read for the other. Broken frontmatter is reported as invalid on every parse, not only the first; before, a second parse of the same bytes in a long-lived process read as an empty success. The cache also kept every distinct document string in memory for the life of the process, and that is gone. Frontmatter semantics and formatting are unchanged.
