---
"@schlessera/brain-ui-server": patch
---

Commit account and security administration, passkeys, reference grants and push registration on the SQLite write worker at FULL durability, so their fsyncs do not block requests. Revocation responses await the durable revocation, and concurrent VAPID first uses share one stored key pair.
