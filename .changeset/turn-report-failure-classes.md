---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Preserve all first-party failure classes in reviewed failed-turn reports through the shared FIRST_PARTY_FAILURE_CLASSES SDK registry. Unregistered third-party classes still report as unknown. This additive export ships as a patch under the maintainer's 0.41.1 batch instruction (#1619).
