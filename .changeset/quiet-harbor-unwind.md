---
"@schlessera/brain-ui-server": patch
---

Keep Inbox staging and budget reservations intact until the originating backend
has finished unwinding. Recover killed attempts conservatively without leaving
cleanup or expired Queue leases permanently blocked.
