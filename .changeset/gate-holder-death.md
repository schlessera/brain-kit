---
"@schlessera/brain-ui-sdk": patch
---

A worker launch whose server dies before releasing the start gate no longer starts its payload (#3392). bubblewrap's `--block-fd` starts the sandbox on the gate's end-of-file, and a dead server's gate reads end-of-file, so the payload used to run without its state, mounts or folder qualification. The gate now runs inside the sandbox in the trusted `/bin/sh`: it needs a complete `go` line, refuses end-of-file, a partial line or any other line, and closes its descriptor before the payload starts. Payload stdin is unchanged.
