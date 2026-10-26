---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits the Activity notifier's tick, intent delivery status, acknowledgements and retention, and push delivery's subscription bookkeeping on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). A delivery pass settles only once its writes have committed, so the next pass never resends an intent.
