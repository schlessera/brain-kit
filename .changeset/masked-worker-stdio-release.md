---
"@schlessera/brain-ui-server": patch
---

Close masked CLI stdin after worker exit and wait for masked CLI and turn-tree maintenance stdio to be released before settling, within the existing 5 second bound.
