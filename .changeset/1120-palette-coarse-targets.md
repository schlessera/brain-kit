---
"@schlessera/brain-ui-kit": patch
---

Make every `CommandPalette` row a 44px touch target under a coarse pointer. The rows were 34px tall (35.7px with a chip) for every pointer, and the palette is the only pointer route to Graph, Sync and Brain statistics. A mouse keeps the 34px rows; the label stays centred on its own line, and a reason that wraps still grows the row downward.
