---
"@schlessera/brain-backend-pi": patch
---

The pi worker pipe reader now joins each frame once instead of copying and rescanning everything pending on every chunk, so a large frame, such as a resumed turn's transcript, is read in linear time. The frames it accepts and refuses, and its 16 MiB bound, are unchanged.
