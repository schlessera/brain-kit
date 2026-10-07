---
"@schlessera/brain-ui-react": patch
---

Ask before leaving the page while staged track files would be lost. While any session or new chat holds a staged track (GPX, KML, GeoJSON), whichever is in view and whatever its upload state, the page asks the browser to confirm a reload, tab close or navigation away, including a reload the app starts itself, such as the one after signing in again. The browser shows its own confirmation, with its own words. Sending or removing the last track removes the guard, and the service-worker update's reload after it never asks.
