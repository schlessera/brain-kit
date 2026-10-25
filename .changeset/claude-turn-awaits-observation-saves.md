---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
---

A Claude turn now settles only after its session's native file observation saves have. A new session's first save is still queued without blocking the stream, but the turn's cleanup waits for it, so nothing is still writing host observation storage once the turn has returned. `NativeFileVersions` on the internal entry gains `settled()`.
