---
"@schlessera/brain-module-diagrams": minor
---

Preserve common callout text and target association in shared client/static,
print and summary output. Add preferred-side hints and readable sans notes.
Repeated-target notes share a target key and grouped band, with every full
note and its original source index. Wide frames use two columns; narrow
frames keep one. Unmarked and semantic-only targets retain explicit notes
without invented geometry.

Breaking validation change: fixed named canvases with neither readable
collision-free inline placement nor notes-band room now return `callout_room`.
Reserve annotation space or choose `size: fit`. When repeated notes still fit
inline but their band does not, preserve all of them inline; this exception
does not expand the validation break. Previously accepted `fit` sources remain
valid.
