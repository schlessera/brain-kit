---
"@schlessera/brain-ui-react": patch
---

Another streamed frame of a turn the tracker store already knows is running no longer writes the store or notifies its subscribers (#4740). A frame that ends the turn, moves a tracker's identifiers or accepts an unconfirmed send still writes, as before.
