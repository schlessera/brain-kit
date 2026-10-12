---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-react": patch
---

Keep classified answer blocks after reloading a conversation whose temporary
artifact links were promoted to persistent scratch. Saved blocks follow the
rewritten text and retain correct spans regardless of classification timing.
