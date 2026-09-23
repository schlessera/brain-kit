---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
---

The sync and briefing panels no longer spin forever on a stream that ends
without a `done` frame. `POST /api/brain/whatsup` now ends on a failed `done`
frame carrying the error when anything throws before its last send, such as a
spawn that cannot start (`POST /api/brain/sync` already did). On the client,
`StreamingPanel` and `WhatsupPanel` treat a stream that closes without `done`
as failed: they keep the output that arrived, say the connection closed before
the job reported a result, and offer Close instead of Cancel.
