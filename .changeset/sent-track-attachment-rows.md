---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

Render sent validated tracks through AttachmentRow with the same identity and
known metadata live and after history replay. Preserve image thumbnails/zoom
and composer retry/remove controls.

AttachmentRow's approved pre-1.0 breaking migration requires `kind` and `label`.
Pass optional duration, metadata, extract and provenance explicitly; sample
facts are no longer defaults. `meta` also accepts a list of wrapping lines.
