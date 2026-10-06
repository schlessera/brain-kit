---
"@schlessera/brain-ui-kit": patch
"@schlessera/brain-ui-react": patch
---

Paper Buttons in the primary and affirm tones keep their near-black label on hover. `--bk-button-hover-fg-primary` and `--bk-button-hover-fg-affirm` now point at `--bk-on-fill` instead of `--bk-color-canvas`, so the hovered label on the amber and teal lift fills is `#231f1a` (8.64:1 and 9.10:1) instead of the paper canvas colour (1.54:1 and 1.46:1). The dark theme resolves to the same `#0c0e12` as before, and fills, borders and caller-owned `style` are unchanged. ui-react's precompiled stylesheet carries the corrected aliases.
