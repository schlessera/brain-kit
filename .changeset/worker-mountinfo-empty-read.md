---
"@schlessera/brain-ui-sdk": patch
---

A governed worker launch no longer refuses intermittently with `invalid worker mount record` while bubblewrap is still building the sandbox (#2701). The worker's PID is reported before its mounts exist, and a mount table opened just before bubblewrap's `pivot_root` detaches the old root reads empty. The folder qualification now observes again after an empty read, within the same deadline and worker-identity checks, and only a complete table that holds every retained folder qualifies. A table that stays empty still refuses at the deadline, and a malformed record still refuses at once. Each refusal now names the call site (`readiness` or `brain-view`), the read's byte and line count, the worker's process state and start time, and the elapsed observation time.
