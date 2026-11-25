---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Storage maintenance `headroom` gains `packingRequiredBytes`. A `pack-git` receipt now carries core's conservative packing preflight need, in bytes, as reported by its own run; before this, ui-server dropped the figure. It is `null`, never `0`, for the other operations, when core reports no figure, on an operation row's own headroom (read the row's `latest` receipt) and on receipts recorded earlier. `requiredBytes` stays `null`. "Prune eligible scratch" also has its own headroom note (the seven-day and 1,073,741,824-byte policy, pinned answers kept) instead of the packing note, and receipts recorded before this release read back with their own kind's note.
