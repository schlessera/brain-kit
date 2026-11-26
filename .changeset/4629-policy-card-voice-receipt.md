---
"@schlessera/brain-ui-react": patch
---

A policy change card keeps its own receipt once it has been answered (#4629). A declined, stale or invalid proposal says "Nothing was written" again, instead of the voice permission receipt that closed the request ("Expired · denied · no answer before the turn ended" at the turn's end, or "Denied on screen"). The voice receipt still speaks for, and locks, a card nobody answered.
