---
"@schlessera/brain-ui-server": patch
---

The inbox lifecycle sweep no longer probes every finished item for a missing staging cleanup on each tick (#4897). A new migration adds `inbox_cleanup_due`, kept by triggers to exactly the triage items whose thread has no cleanup for them yet, and the sweep reads finished work only from those threads. Its work no longer grows with the number of settled threads; the items it acts on, and the order, are unchanged.
