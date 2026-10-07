---
"@schlessera/brain-ui-kit": patch
---

`CommandPalette`: a disabled row's reason no longer squeezes its label to an
ellipsis. The reason stays on the label's line, right-aligned, while the label,
its chips and the whole reason fit side by side; otherwise it drops to a line
of its own under the label and wraps there, with the icon kept beside the
label. Rows with a short reason look as before.
