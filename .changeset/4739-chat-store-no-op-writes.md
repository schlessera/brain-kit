---
"@schlessera/brain-ui-react": patch
---

A chat-store write that changes nothing no longer notifies subscribers (#4739). The text and thinking deltas a host stamps with a `turnId` now reach the store once per animation frame, as the delta buffer promises, instead of once per WebSocket frame. A write that changes nothing still stamps a journal receipt a message is missing, and it no longer moves its buffer in the eviction order.
