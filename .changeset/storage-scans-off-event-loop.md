---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits shared storage scan leases and storage maintenance receipts on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#3028). A scan's collector starts only after its lease commits, a maintenance route answers once its receipt has committed, and a cancellation takes effect once it is durable.
