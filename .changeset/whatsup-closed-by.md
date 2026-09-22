---
"@schlessera/brain-ui-react": patch
---

A stray click on the backdrop no longer cancels the briefing `/whatsup` is
loading, nor discards the one it has just produced. The briefing drawer now
carries the same `closedBy` prop as the sync panel — `none` while the briefing
loads, so neither the backdrop nor a reflexive Escape can abort a model call
mid-flight, and `closerequest` once it has arrived, failed or been cancelled,
so Escape dismisses it but a click beside the drawer does not. The header's X
closes it in every state, and the footer's Cancel still aborts the request.
