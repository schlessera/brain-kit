---
"@schlessera/brain": patch
---

Pruning `.brain-cache/contexts.jsonl` no longer drops lines that another run published while the prune scanned the chunks (#4874). The prune now reads the file again after the scan and filters that content. A line whose key the first read did not hold is kept, and a line removed in the meantime (by `--forget-cache`, say) is not written back. Before, a plain `brain index` could undo an embeddings run's new context lines, and a rebuild that followed paid to generate them again.
