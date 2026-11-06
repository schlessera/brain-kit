---
"@schlessera/brain": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Path-containment checks that were written inline (`path.startsWith(`${root}/`)`, `root + sep`) or as local `within`/`under`/`inside` helpers now all go through the shared `isWithin` helper (#3423). Every check keeps its previous answer, including for `/`, a root ending in a separator, sibling prefixes such as `/a/b` and `/a/bc`, and unnormalised paths. `bun run lint` now refuses a new inline check in package source.
