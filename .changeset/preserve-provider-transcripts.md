---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

Preserve runtime-written provider transcript entries across turns. Store promoted
answer-link display mappings and authoritative Pi application receipts in host-owned
replay metadata so history retains promoted links and receipts without changing
prior model text or tool results. Recover only missing results for runtime-written
Pi calls after the worker exits; direct server applications create no provider entry.
