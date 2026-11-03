---
"@schlessera/brain-ui-react": patch
---

Reopening a session whose turn is still running no longer clears its tracker. The seen observer could record proof from the turn id the live frames left on the answer before the history replay arrived. It now ignores an answer that is still being written, so the tracker stays until the turn has ended and its end is on screen.
