---
"@schlessera/brain-ui-server": patch
---

Keep the host available when a full journal defers startup receipt recovery. Retain unchanged recovery rows, record the cause in journal cleanup status, and retry on the next open with headroom.
