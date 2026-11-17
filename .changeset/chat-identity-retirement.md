---
"@schlessera/brain-ui-server": patch
---

The UI database gains an internal, content-free ledger of retired chat identities (#3228, migration `073_chat_lifecycle.sql`). Nothing retires a chat yet: there is no endpoint, backend removal or UI, and no content is deleted. Once a later release retires a chat, its session, dialogue owners and aliases, conversations and consumed task and request identities stay refused permanently, across restarts and in operational backups taken afterwards. An operational backup taken before a retirement still restores that chat's text; the recovery documentation states this limit.
