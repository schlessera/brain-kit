---
"@schlessera/brain-ui-server": patch
---

Storage history no longer records "Brain: 0 bytes" as complete evidence when the brain root has no disk mapping. When core inventory fails, or a store that may hold bytes has no capacity or one of unknown identity, its owner's per-disk logical and allocated totals are now recorded as unknown (`null`) on every disk the store could be on, and that disk's coverage is partial. Measured rows on a disk stay as a lower bound. A known zero is kept when every store of that owner is mapped to another disk, and an absent optional store still places nothing. Hosts that list unmeasured app stores (such as native checkpoints) now record App as unknown, not 0, on a disk with no measured App store, and those disks read as partial.
