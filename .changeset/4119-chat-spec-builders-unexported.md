---
"@schlessera/brain-ui-react": patch
---
Removed: the `export` keyword from three chat handler functions (`listSpecFromInput`, `formSpecFromInput`, `rankSpecFromInput`) that only their own file calls. No entry point's exports changed.
