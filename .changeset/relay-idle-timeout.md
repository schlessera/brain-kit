---
"@schlessera/brain-ui-sdk": patch
---
The inference and provider relays no longer drop a response that pauses for more than 10 seconds. A Claude turn writing one large tool input could go that long without stream bytes; the relay closed the socket and the turn failed after three attempts with "Connection lost mid-response". The relays now disable Bun's idle timeout for the whole server, because Bun ignores the per-request override once a response is streaming.
