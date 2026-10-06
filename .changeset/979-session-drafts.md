---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Keep each session's unsent composer draft on the host, so its text and images
survive a reload, a closed tab or a host restart and come back on the same
operator's other devices. The host stores drafts in its own operational
database (never `brain.db`) behind six authenticated routes under
`/api/drafts`: list, read, save with `If-Match` and `Idempotency-Key`, upload
an image, delete (leaving a tombstone) and bind an unbound draft to the
session its accepted first message started. Concurrent saves of one revision
get one success and a `DRAFT_CONFLICT` carrying the host's version; nothing
is merged, evicted or expired. Limits are 64 KB of text, 8 MB per draft, 100
drafts and 256 MB per host. Additive: `server_hello.capabilities.sessionDrafts`
with `server_hello.sessionDraftLimits`, the optional `chat_message.draftRef`
(an accepted message consumes exactly that revision), the `Draft*` protocol
types and response schemas, and `If-Match`/`Idempotency-Key` in the
configured CORS allow-list.
