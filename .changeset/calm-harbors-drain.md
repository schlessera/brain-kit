---
"@schlessera/brain-ui-server": patch
---

Keep admitted HTTP handlers alive until they finish before closing server operational state. Refuse new requests during shutdown and cancel stalled request bodies without waiting for an unresponsive body producer.
