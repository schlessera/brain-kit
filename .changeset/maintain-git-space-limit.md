---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
---

`brain maintain`'s git step names the space limit it hit instead of git's bare `Out of diskspace` (#3357). The step result begins `FAILED — no space:` and gives the space available when the step started. In a hosted maintenance worker, whose launcher now declares the output stage in `BRAIN_WORKER_OUTPUT_ALLOWANCE`, it also names the stage's allowance in bytes and `BRAIN_UI_OUTPUT_STAGING_BYTES`, the setting to raise. `brain storage pack --json` now reports `reason: "no_space"` for git's own out-of-space wording as well. No JSON shape changes.
