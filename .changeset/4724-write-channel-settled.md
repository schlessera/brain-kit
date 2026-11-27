---
"@schlessera/brain-ui-server": patch
---

Internal: the hosted stores share one write-tail helper beside the write channel (#4724). The reference-write and draft `settled()` waits now also wait for a write submitted while they wait, as every other store's already did; no route, frame or stored row changes.
