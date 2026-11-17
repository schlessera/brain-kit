---
"@schlessera/brain-ui-react": patch
---

The WebSocket client is now composed from separately tested parts: the socket lease, the gated outbound path, inbound routing, reconnect healing, session restoration, turn retries and account services. Retry and answer receipts and session queue reports are handled through the typed frame handler map. Behaviour and the wire protocol are unchanged.
