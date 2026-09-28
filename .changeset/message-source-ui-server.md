---
"@schlessera/brain-ui-server": minor
---

The host keeps the `source` a client sends on `chat_message` and joins it back onto the user messages a backend replays, on `session_resume` and on the snapshot sent to a reconnecting client, whether or not a classifier is configured (#549). Sources live in a new `message_sources` table (migration `017_message_sources.sql`), keyed by session, a hash of the message's exact text, and its ordinal among identical texts. A message is recorded when its text is handed to the backend, so a message that is queued and then dropped is never counted. `SessionCatalog` gains optional `recordMessageSource` and `attachMessageSources` (a catalog without them replays every message as typed), and `WsHost.prepareHistory` joins sources and then classified blocks; `WsHost.attachMessageBlocks` is unchanged.
