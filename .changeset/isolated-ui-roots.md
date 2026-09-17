---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": minor
---

Add UI roots and a React provider with independent stores, persistence, request
caches, renderer/ASR registries and WebSocket lifetimes. Store hooks select from
the nearest provider; connection handlers close over that same root. Multiple
consumers share one socket within a root, and disposing it releases its resources.

Add an ASR registry factory to the SDK. The default application entry points
remain available. Component API/config migration is still in progress, so this
does not yet make the entire application safe for separate backends in one page.
