---
"@schlessera/brain-ui-react": patch
---

A new chat that holds only staged track files (GPX, KML, GeoJSON) stays reachable after New chat. Sessions lists it under `Drafts` as `Draft with 1 track file`, with the state line `draft · tracks in this tab only`; a draft that also has text or images reads `draft · {save state} · tracks in this tab only`. A failed upload (`1 track failed`) is shown before one still under way (`uploading 1 track`). Opening the entry brings back the same staged tracks, uploads continuing, and sends nothing. Removing the last track from a chat with no text or images takes it out of Drafts at once and puts focus in the composer field. At 1280 and wider, the Sessions pane's `New conversation` is available while the new chat holds staged tracks. Tracks are never called saved: they live in this tab's memory only.

`useServiceWorkerUpdates` now also waits while any session or new chat holds a staged track, whichever is in view, and reloads once when the last one is sent or removed.
