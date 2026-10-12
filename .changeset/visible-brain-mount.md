---
"@schlessera/brain": patch
---

Read Linux mount parent topology when checking whether the brain is read-only, so a writable mount over a read-only mount can run CLI writes and hidden descendant mounts cannot override the visible boundary.
