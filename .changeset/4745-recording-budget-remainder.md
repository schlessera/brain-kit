---
"@schlessera/brain-ui-react": patch
---

A device recording reads its storage budget once when it begins and keeps a running remainder, instead of scanning every stored chunk size before each one-second chunk (#4745). The budget is read again only when fewer than 30 seconds of audio would remain, so freed space or a changed quota is still noticed, and a chunk that does not fit still stops the recording with the "storage is full" message and keeps what was saved.
