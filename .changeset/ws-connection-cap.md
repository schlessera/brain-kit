---
"@schlessera/brain-ui-server": minor
---

WebSocket connections are capped per process (`BRAIN_UI_WS_MAX_CONNECTIONS`, default 32). An over-cap upgrade is refused with HTTP 503 before the handshake, a socket that slips through the race window is closed with code 4008, and membership is keyed on the raw socket so reconnects free their slot.
