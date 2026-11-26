---
"@schlessera/brain-ui-server": patch
---

A Google session allowance no longer stops brain-wide safety recording recovery when its chat holds a safety record or acknowledgement that is not valid JSON (#4631). The continuity check treats such a value as unreadable instead of failing the write it runs in, so recovery at boot or by the owner clears the latch again. That chat stays restricted, and its allowance admits nothing until the value is readable.
