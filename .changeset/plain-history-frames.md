---
"@schlessera/brain-ui-server": patch
---

Replay long session histories without dropping messages. Frame sizing now
measures UTF-8 bytes rather than string length, each message is bounded once
against the chunk budget instead of twice against the whole frame, identity
fields survive shrinking, and a truncation can no longer split a surrogate pair.
