---
"@schlessera/brain-ui-sdk": minor
---

Pass freshly written scratch mask paths to the optional host prune hook so the
host can retain the output reported by the tool. Produced paths are canonical
and brain-relative, independent of the adapter's display path.
