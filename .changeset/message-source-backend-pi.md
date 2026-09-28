---
"@schlessera/brain-backend-pi": patch
---

A replayed user message no longer shows the notes pi adds about the images it resized, converted or dropped (`[Image: original 4032x3024, displayed at …]`) as if the user had typed them (#549). The history reader removes a trailing run of those notes after a blank line, so the replayed text is the text that was sent, which is also what the host matches a message's source on.
