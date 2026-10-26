---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits shared storage scan leases and maintenance receipts on its SQLite write worker at full durability, keeping collectors, route responses and cancellation behind their required commits without blocking the event loop.
