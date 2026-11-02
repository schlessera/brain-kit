---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Turn journal summaries add an optional `keptFiles` count: the distinct paths whose content, steering, policy or workspace change the journal retained. Metadata-only index entries, ignored paths and `other` entries are excluded; `changedFiles` keeps counting every observed path. The collapsed receipt now names retained files, so a turn that only refreshed the search index reads "0 changed files". A partial journal's count reads "At least …", and a summary recorded before this field names its recorded entries ("1 entry recorded") rather than files.
