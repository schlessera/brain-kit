---
"@schlessera/brain-ui-server": minor
---

The owner can continue a chat from another device (#3952). Every sign-in mints its own owner principal, and a chat's safety history was bound to the one that started it, so a turn from any other login was refused as a safety principal mismatch. The history now belongs to the account: any owner login continues the chat, its turns join the same safety history and taint, and it can read and review that history. An agent, a proxy user or any other account is still refused. Stored rows are not rewritten.
