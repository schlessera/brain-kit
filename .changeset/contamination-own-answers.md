---
"@schlessera/brain": patch
---

`brain eval`'s contamination check no longer flags a document for quoting the queries it answers. Exact-title and alias queries quote their own target by construction, so a set of them warned about the very documents it expects, and `--strict` refused it. A query now counts against every indexed document except those in its own `expected` list.
