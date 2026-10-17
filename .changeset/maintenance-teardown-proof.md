---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

Clarify maintenance completion and sync-mirror validation: namespace init retains output pipes after the outer monitor can exit, and a teardown artifact must still be refused before transport. Runtime behavior is unchanged.
