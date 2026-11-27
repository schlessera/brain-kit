---
"@schlessera/brain": patch
---

The MCP server's staleness cache now times its probe on a monotonic clock, so a step of the system clock during a probe no longer stretches how long its answer is reused (#4888). Its write tools reset the cache only when they wrote a file: a `brain_add`, `brain_update` or `brain_archive` refused before any file changed (a missing path, nothing to change) keeps the cached answer, so a client alternating refused writes with reads no longer forces a full probe on every read. A write whose index run fails after the file was written still resets it. The warning text and the lifetime rule are unchanged; the lifetime gets no ceiling, since a ceiling below a probe's own cost would let probes run back to back.
