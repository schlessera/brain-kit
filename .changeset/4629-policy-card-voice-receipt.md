---
"@schlessera/brain-ui-react": patch
---

A policy change card that was answered on screen keeps its own receipt (#4629). A declined, stale or invalid proposal says "Nothing was written" again. Before, the permission receipt that closed the request replaced it: "Denied on screen", or "Expired · denied · no answer before the turn ended" when the turn ended without a host resolution. A voice refusal and the host's own expiry reason still show on the card, and a card nobody answered still shows the turn-end receipt and offers no decision.
