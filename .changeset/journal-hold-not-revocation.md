---
"@schlessera/brain-ui-server": patch
---

A host-applied write that overlapped a journal observation or a scope pause was refused as `authority_revoked` even though the turn's principal was still valid (#2853). With quick applications the window was easy to hit: one write in a turn failed and the next succeeded. An observation or pause now holds the write instead. The write waits outside the shared brain lock, each wait for at most 60 seconds, then commits once the hold clears. Nothing commits while a hold is active. Image masks, policy publication and the other host bridge calls wait the same way. A principal that really lost authority still refuses with `authority_revoked` at once, even mid-wait. A write still held when the 60 seconds run out refuses with `application_failed` and changes nothing, so `authority_revoked` keeps its meaning.
