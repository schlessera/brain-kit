---
"@schlessera/brain-ui-react": patch
---

A voice permission receipt now replaces only the message that owns its tool call, so every other message keeps its identity and its drawn bubble (#4742). The permission router re-applies its receipts only for a session whose transcript changed, instead of for every receipt on every chat write; a receipt that arrives before its tool call is still applied when the call appears.
