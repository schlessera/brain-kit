---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits local exchanges, a turn's classified blocks and classifier confidence, and a saved worker preference (`PUT …/profile`) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). A local exchange is still carried by the next prompt while it commits, and is answered once stored; a replayed history waits for the classified blocks submitted before it.
