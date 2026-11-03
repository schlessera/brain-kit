---
"@schlessera/brain-ui-sdk": patch
---

A separate-UID worker launch whose identity coordinator dies before releasing the start gate no longer starts its payload (#3402). The coordinator's gate is bubblewrap's `--block-fd`, which starts the sandbox on end-of-file. Every separate-identity payload now also waits behind the trusted stdin gate, a complete `go` line that the server writes only after the coordinator confirms the release. The identity helper protocol is unchanged, and payload stdin after the gate line is byte-identical.
