---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": patch
---

An authenticated owner can delete its own chat's local history with
`POST /api/chat-deletions` (#3230). The chat is retired first; then its
backend's native history, canonical dialogue, task receipt text, session
projections and positively bound drafts are removed, each confirmed by its
own store. The receipt reports every store's outcome (`removed`, `pending`,
`partial` or `unknown`) and always lists what local deletion keeps:
independent saved content, effects and their audit, provider copies, backups
and offline devices. A repeated operation, or a host restart, finishes an
unconfirmed cleanup. Agents, ambient callers without an owner mapping and
other principals are refused, as are busy chats and backends that cannot
remove native history. A deleted chat is absent from every list, read,
resume, recovery and live-startup path, even for an older client; capable
clients of the same owner receive `chat_retired`. The SDK adds the request,
receipt, frame, capability and schema, and drafts gain `DRAFT_CHAT_RETIRED`.
