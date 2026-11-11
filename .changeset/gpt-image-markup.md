---
"@schlessera/brain-module-images": minor
---

`brain image --markup <path>` sends an annotation layer with an edit on the GPT Image 2.6 and 2.5 models: a transparent PNG the size of the first `--ref`, posted as the `markup` part of `/v1/images/edits`. Markup without a `--ref`, with `--mask`, that is not a PNG with an alpha channel, whose size differs from the first reference (measured after a JPEG's EXIF orientation), past 16,777,216 pixels or 50 MB, or on Gemini is refused before any request.
