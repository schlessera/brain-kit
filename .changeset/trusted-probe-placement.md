---
"@schlessera/brain-ui-server": patch
---

Keep worker identity probe sentinels in validated server state outside the brain, including memory-backed apps with native lease state, so concurrent checkpoints cannot capture private probe inputs.
