---
"@schlessera/brain-ui-sdk": patch
---

The native reference pool's `poolRelease` refuses a writable worktree that an access generation still holds, with `invalid`, deleting nothing and keeping its charge; park it first. The manager runs one request at a time, so the refusal is atomic with `poolAccess`, and no caller in this process or another can delete a worktree under its running worker.
