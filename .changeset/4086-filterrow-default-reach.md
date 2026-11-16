---
"@schlessera/brain-ui-kit": patch
"@schlessera/brain-ui-react": patch
---

Interactive `FilterRow` pills now reach a 44px touch target by default. Under `any-pointer: coarse` each pill with an `onClick` carries `.bk-hit`, keeps its 20.5px paint height and paints at least 44px wide, and the strip clips only horizontally so the vertical reach is not cut off. Under a fine pointer, and for decorative pills, nothing changes. `FilterRowProps` is unchanged. A caller that puts a reaching control within 11.75px above or below a reaching row should widen its coarse-pointer row gap.

The file viewer's Preview/Raw pills no longer draw a 44px box, and the Actions dismissal reasons use the kit pill (29.5px) and reach 44px on touch instead of drawing a 44px pill. Their names, pressed state and keyboard behaviour are unchanged.
