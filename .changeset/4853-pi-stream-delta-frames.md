---
"@schlessera/brain-backend-pi": patch
---

A pi worker now sends each streamed text or thinking delta to the host as its type and text only. Before, every delta frame also carried the whole answer accumulated so far, twice, so a long answer piped and parsed a quadratic number of bytes that nothing read. The host refuses a delta frame that carries anything else. The frames clients receive are unchanged.
