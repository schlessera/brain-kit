---
"@schlessera/brain-ui-react": patch
---

A draft save the brain refuses with a 400 is no longer retried forever. The client tries one recovery for an edit (re-uploading images, re-reading a refused snapshot list, or leaving out an original the brain no longer stores) and then stops until the draft changes, showing "Draft not saved: the brain refused it". A draft holding only originals carried from another draft id is no longer saved as empty; it waits for content or for its files to be chosen again. An original the brain no longer stores is marked not attached and the next save goes through without it.
