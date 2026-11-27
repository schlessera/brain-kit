---
"@schlessera/brain-ui-sdk": patch
---

Internal: the worker launcher's repeated sequences are written once (#4722): one private-tmpfs opener for runtime state and turn temp, one root-owned pool-directory check for managed worktrees and reference views, one identity hand-off for the launch and the host probe, and one release of the launch inputs. No mount, bind, identity enrolment, cleanup order or error text changes.
