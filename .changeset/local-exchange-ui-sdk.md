---
"@schlessera/brain-ui-sdk": minor
---

A command the client answers itself (`/stats`) can be kept as part of its session (#582). New `local_exchange` client frame (`{ sessionId, exchange: LocalExchange }`), new `local_exchange_result` server frame (`{ sessionId, exchangeId, saved, reason? }`), optional `ClientChatMessage.localExchanges` for a draft conversation's exchanges, and optional `SessionHistoryMessage.localAnswer` (`{ exchangeId, command, answer }`) on replayed assistant messages. `LocalExchange` is `{ id, command, prompt, answer, context }`; the schema bounds `context` to `MAX_LOCAL_CONTEXT_CHARS` and refuses one containing `LOCAL_ANSWER_CLOSE`. All additive: a peer that does not know them ignores them, and a `localAnswer` this build cannot read is dropped rather than failing the history.
