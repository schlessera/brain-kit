---
"@schlessera/brain": patch
"@schlessera/brain-module-images": patch
"@schlessera/brain-ui-server": patch
---

A write into the scratch area no longer deletes its own output when files linked from retained conversations already exceed the 1 GB cap. `brain render`, `brain geo map`, `brain okf export`, `brain image` and the chat UI's scratch mask now protect the files they just wrote during the prune that follows, so a successful report always names files that exist. Later prunes treat that output like any other unlinked file; the seven-day and 1 GB defaults are unchanged and pinned overage is still reported.
