---
"@schlessera/brain-ui-server": patch
---

Bound the historical host outcomes that the Gemini Live and GPT Live adapters send when a replacement epoch opens. The limit is in exact UTF-8 bytes: 24,000 for Gemini and 7,500 for GPT, of which at most 16,000 and 5,000 may be result text. Selection is newest first. A result that does not fit whole is replaced by its request and state marked `resultOmitted`, and when older outcomes are dropped the block starts with an explicit marker. Gemini now seeds this history in its documented ordered-history mode before any audio. Context that already fits is sent unchanged. The GPT limit is estimated headroom under its documented 8,192-token startup input, not a proven token bound.
