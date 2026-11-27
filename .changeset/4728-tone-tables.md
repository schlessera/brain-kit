---
"@schlessera/brain-ui-kit": patch
---

Internal: kit components read a tone's colour from `accent` at the use site, or through one internal helper for value tones, instead of a private per-component table (#4728). Rendered colours are unchanged, and a tone outside a component's union still reads as that component's fallback colour.
