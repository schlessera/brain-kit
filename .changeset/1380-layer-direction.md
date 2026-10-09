---
"@schlessera/brain-ui-react": patch
---

Internal: ui-react's stores, lib and connection modules no longer import its
components. The pure helpers they used moved into `lib/`. The public exports
are unchanged.
