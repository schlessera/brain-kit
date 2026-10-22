---
"@schlessera/brain-ui-server": patch
---

Freeze a maintenance command's Git attributes in one worker launch instead of one launch per object, which cut each hosted maintenance run's Git preparation by about two thirds on a loaded host.
