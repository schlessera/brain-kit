---
"@schlessera/brain-ui-server": patch
---

A draft save no longer rewrites the rows of images that are already attached (#4898). Updating `attached = 1` on such a row rebuilt the whole record, image bytes included, inside the save's write transaction, so every autosave of a draft with images read and rewrote each image. The first save that lists a fresh upload still attaches it, and an image a save drops is still deleted.
