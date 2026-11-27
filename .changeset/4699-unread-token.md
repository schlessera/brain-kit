---
"@schlessera/brain-ui-kit": patch
---

The kit's stylesheet no longer declares `--bk-orbit-glow`, which no component read (#4699). Custom properties are not part of the integration contract; a host stylesheet that referenced this one should drop it. A test now reports any declared token that nothing reads.
