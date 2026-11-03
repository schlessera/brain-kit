---
"@schlessera/brain-common": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain": patch
---

The governance policy file is read through one descriptor-anchored reader (#2508). `brain policy`, the indexer, `brain stats`, the hosted server's policy reader and its policy writer now share `openGovernancePolicyAnchored` and `verifyGovernancePolicyAnchored` in `@schlessera/brain-common/internal/governance-policy`, so a hardening fix reaches all of them. Each keeps the stricter rule of the two former copies. The writer no longer loads a file that grows past the 1 MiB bound after its size check, and it refuses a short read as a change. `checkGovernancePolicy` now refuses an ancestor directory replaced during the read on Linux as well, and reports an ancestor removed during the read as invalid rather than missing. The writer's review states and messages are unchanged.
