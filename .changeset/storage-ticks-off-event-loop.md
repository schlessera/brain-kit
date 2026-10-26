---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits its storage history flush and storage notice bookkeeping (the 20-second sweep, and a delivery's begin and finish) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). Buffered observations are kept until their flush commits, and shutdown waits for the final one.
