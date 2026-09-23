---
"@schlessera/brain-ui-sdk": minor
---

A table wider than four option columns is no longer asked which column the text
recommends. That question offered one option per column, the classifier takes at
most 255, and one oversized question failed the classification pass for every
candidate in the answer. A comparison is drawn with at most four options, so the
answer had no use for a wider table anyway. Its shape is still asked, so a table
of up to six columns can still become a data table.
