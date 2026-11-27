---
"@schlessera/brain-ui-server": patch
---

Six routes that carried their own capped body reader now read through the shared one (#4774): draft saves, binds and image uploads, the markup layer upload, schedule requests, saved-audio transcriptions, session and draft profile settings, and shares. Each keeps its own limit, status, error code and message. The session and draft profile routes (`PUT /api/sessions/:id/profile`, `/code-changes` and the draft equivalents) now refuse an over-declared `Content-Length` before reading the body, and accept the JSON media type in any case with parameters (`Application/JSON; charset=utf-8`), as every other JSON route does; any other media type is still 415.
