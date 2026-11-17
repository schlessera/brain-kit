---
"@schlessera/brain-module-diagrams": patch
---
Edge labels and ER cardinalities no longer land on a group heading. Previously a label's opaque mask could cover part of the heading, so the two texts painted over each other. When no clear position remains, `brain diagram check` now refuses the spec with `unroutable` instead of calling it valid.
