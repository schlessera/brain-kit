---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Preserve all first-party failure classes in reviewed failed-turn reports through the shared FIRST_PARTY_FAILURE_CLASSES SDK registry. Unregistered third-party classes still report as unknown. The additive SDK export ships in a minor release (#1619).
