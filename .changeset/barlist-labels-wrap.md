---
"@schlessera/brain-ui-kit": patch
---

`BarList` labels wrap instead of being cut off with an ellipsis (#174). A bar list row is the record, so a long document type or agent name is now shown in full: it breaks at spaces and hyphens, and mid-word only when a single word cannot fit. The bar and the figure stay on the label's first line, and continuation lines fill the label column alone. Rows are about 4px taller than before, including single-line ones. No prop changes.
