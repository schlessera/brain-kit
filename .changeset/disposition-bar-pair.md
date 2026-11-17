---
"@schlessera/brain-ui-kit": patch
---

`DispositionBar` fills its container and wraps Later and Dismiss as a pair. When the commit, Later and Dismiss do not fit on one line, the commit takes the first row and Later and Dismiss share the second at equal width. Before, Dismiss sat alone on a second row at every phone width. On a wide container all three stay on one row, with the commit taking the remaining width.
