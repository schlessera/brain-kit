---
"@schlessera/brain-ui-server": patch
---

The shared request body reader behaves the same for a `Request` built in process as the per-route reads it replaced (#4903). A declared `Content-Length` too long for a number is refused as over the limit instead of skipping the check; JSON bodies and share uploads copy each chunk as it arrives, so a stream that hands over one buffer twice cannot change the result; and a schedule request with no body and an over-limit declared length is answered "Request body too large." again.
