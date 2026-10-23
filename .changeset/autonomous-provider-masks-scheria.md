---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Apply governance policy provider folders to autonomous turns (#2691). A restricted autonomous turn under a provider rule now reads each masked folder as empty and searches a private index built from the masked view, removed when the turn ends; its server-side brain tools refuse masked paths. Autonomous admission reads the same last-valid policy as hosted turns and refuses unsupported type, glob and single-path selectors by name before any worker starts.
