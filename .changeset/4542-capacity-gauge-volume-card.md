---
"@schlessera/brain-ui-kit": minor
---

Add `CapacityGauge`, `VolumeCard` and `VolumeGroup` for the Storage pane's volumes (#4542). `CapacityGauge` draws one capacity scope as a used → reserved → available track against total, with Low and Very low threshold ticks at the positions its `thresholds` prop gives. It is a `meter` valued in bytes, with "{available} available of {total}" as its value text, and an unknown or inconsistent capacity draws a text mark instead of a bar. `VolumeCard` adds the name, a status chip (OK, Low, Very low, Not measured, each a word, and the last three a glyph), the available figure, Trend and Runway, the stale, scope-changed and unidentified notes, and the stores list on demand. `VolumeGroup` makes the cards one `radiogroup` with a roving tab stop, arrow-key selection and an `auto-fit, minmax(260px, 1fr)` grid. The pure geometry (`capacitySegments`, `tickLayout` and helpers) is exported too.
