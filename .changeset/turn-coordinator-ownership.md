---
"@schlessera/brain-ui-server": patch
---

Closing the host now rejects every pending location and mask request and denies every pending approval or question, including ones whose turn had already stopped. Previously those requests could stay unsettled. Turn state is now owned by the coordinator; the ask-user duplicate-id rules are unchanged.
