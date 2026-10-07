---
"@schlessera/brain-ui-kit": patch
---

Move loading ghost sweeps to one compositor band per frame, with broad, smooth
edge fades and static glyphs. Preserve the per-item 600ms arrival handoff and
reduced-motion/print behavior; queue and search rows no longer stagger sweeps.
