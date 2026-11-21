---
"@schlessera/brain-ui-sdk": patch
---

Give each cleartext HTTP proxy operation its own non-pooled upstream connection so a stale same-origin socket cannot produce a spurious 502. Preserve cancellation, admission fences and byte accounting without retrying requests.
