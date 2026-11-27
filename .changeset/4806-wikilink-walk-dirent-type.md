---
"@schlessera/brain-ui-server": patch
---

Building the wikilink map takes each entry's type from its directory entry and calls `stat` only for symbolic links (#4806), instead of awaiting a `stat` for every file in the brain. Symlinks keep their containment check, and the map, including which file wins a shared slug, is unchanged.
