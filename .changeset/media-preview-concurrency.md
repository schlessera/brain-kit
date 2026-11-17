---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

A media effect's preview now says how large the file is (#2781). `brain hygiene media <action> --dry-run --json` adds `media: { width, height, durationMs }`, read from the first 64 KiB of the file's header: the pixel size of a PNG, GIF, JPEG, WebP or BMP image or of an MP4/MOV video, and the duration of an MP4/MOV/M4A or WAV. A value the header does not state within that read is `null`, never guessed.

Hygiene review runs one media preview scan per server. A newer preview from the same person aborts the older scan and stops its CLI, and the older request gets `preview-superseded`. A preview from someone else while a scan runs gets `preview-busy`. Nothing is queued or retried. A preview whose card would be larger than the 512,000-byte transport limit is refused as `inventory-too-large` (`limit: "preview"`), rather than stored and truncated.

`POST /api/hygiene/review/preview` accepts an optional `requestId` and echoes it. The response is still the pending Action, now with `refusals` (named refusals are a 200 result) and, for a media option, `media`. Errors and their status codes are unchanged. The UI SDK adds `HygienePreviewResponse`, `HygieneMediaProbe`, `hygieneMediaProbeSchema`, `HygienePreviewRequest.requestId` and the optional `HygieneMediaPlan.media`.
