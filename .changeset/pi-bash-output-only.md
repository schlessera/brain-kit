---
"@schlessera/brain-backend-pi": patch
---

Remove the redundant command echo from Pi bash results so clipping and model context contain command output only. Empty output returns `(no output)`; nonzero exit trailers remain intact.
