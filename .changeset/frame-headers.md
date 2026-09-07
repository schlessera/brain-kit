---
"@schlessera/brain-ui-server": minor
---

Every HTTP response carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (the raw file response appends the directive to its own CSP). Only a genuine WebSocket upgrade on `/ws` is exempt; a plain HTTP request to `/ws` now gets 400 instead of falling through to the SPA.
