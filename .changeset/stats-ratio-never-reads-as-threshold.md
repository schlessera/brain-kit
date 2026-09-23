---
"@schlessera/brain": minor
---

`brain stats` human output: a health ratio that rounds to the same one-decimal figure as its threshold is now printed with more decimal places. Before, 6 broken links in 119 read `5.0%, over the 5.0% ceiling`. It now reads `5.04%, over the 5.00% ceiling`, with the ratio and threshold widened together. Every other line prints exactly as before, verdicts still compare the unrounded values, and `--json` is unchanged.
