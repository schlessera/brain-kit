---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-common": patch
"@schlessera/brain": patch
---

The note a hosted agent reads before its turn is shorter and states its rules directly (#1654). It opens with the turn's profile (`strict`: the brain is read-only, change it through `write_file`, `edit_file` and the curated tools), lists turn temp, the persistent areas and the brain, and ends with the link rule: anything the reader should open goes in `.brain/scratch/` and is linked from there. Each area is named by the path the worker was actually given. Both backends inject the same text. When a `brain` CLI write hits the read-only brain, the refusal now repeats the note's rule word for word; the `read_only_brain` code and its `tool` field are unchanged.
