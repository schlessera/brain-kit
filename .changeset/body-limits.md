---
"@schlessera/brain-ui-server": minor
---

JSON routes read their body through `readJsonBody`, which refuses an oversized `Content-Length` before touching the stream and cancels a chunked body the moment it crosses the cap (256 KB; 5 MB for `/api/render`, measured in bytes, replacing the zod character count). The read happens where the handler calls it, so the login admission checks still run before any body is read and the request object is never swapped. Share intake counts its in-flight slot before the first await. `MAX_ARCHIVE_BYTES` is exported and the README carries the full `Bun.serve` recipe (`maxRequestBodySize`, idle timeout, WebSocket payload cap, warm-up, shutdown).
