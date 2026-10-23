---
"@schlessera/brain-ui-server": minor
---

Hosted turns with provider folder masks now refuse admission, naming the files, when a regular file outside the masked folders is a hardlink to a file inside one; the mask hid only the name, so the turn could read the masked bytes through the other one.
