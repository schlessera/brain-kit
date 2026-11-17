---
"@schlessera/brain-ui-kit": patch
---

A dispatched (untrusted) Escape keydown closes an open panel again. A synthetic keydown raises no platform close request, so it never reached the panel's close watcher, and the panel stayed open. A real Escape and Android back still arrive through the watcher, once.
