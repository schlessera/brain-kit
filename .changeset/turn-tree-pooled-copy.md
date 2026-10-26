---
"@schlessera/brain-ui-server": patch
---

A strict, voice or autonomous turn's data tree is built faster: admission copies its files and the index seed sixteen at a time off the event loop, requesting a reflink, instead of one file after another, and an aborted admission stops the copy and removes it. On the native fixture this halves the copy (2,000 notes 100 ms to 51 ms, 10,000 notes 471 ms to 245 ms).
