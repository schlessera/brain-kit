---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Add an optional, separately qualified reference pool volume to the host-only native storage manager. It charges actual unique Btrfs allocation against a configurable 10 GiB combined and 2 GiB per-operation allowance, enforces both with simple-quota kernel limits, shares physical backing headroom through a ledger, records durable intents through reclamation, and exposes `brain-native-store pool status|recovery|release` for operators. No acquisition, worktree or worker access is enabled yet.
