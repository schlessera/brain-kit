---
"@schlessera/brain-ui-sdk": patch
---

The worker host reads `/proc/<pid>/stat` through one parser that names the state, parent and start-time fields and refuses a line whose parent or start time is not a number, instead of picking fields by index at eighteen sites. The three ways of listing a process's children are now one: the sandbox lookup after a bubblewrap launch and the refusal kill of a status-gated launch read every thread's `children` record, drop duplicates and re-read each child's parent, so a child that has exited and been reaped, or a PID reused since, is no longer counted or signalled.
