---
"@schlessera/brain-ui-server": minor
---

The host keeps locally answered commands as part of the session (#582). A `local_exchange` frame, or a draft conversation's `localExchanges` on its first `chat_message`, is stored in a new `local_exchanges` table (migration `018_local_exchanges.sql`) and answered with `local_exchange_result`. The next prompt handed to the backend in that session (a new turn, a queued follow-up or an injected one) carries each pending exchange's `context` in a `<local-answer>` block after the user's text, once. `WsHost.prepareHistory` strips that block from the prompt that carried it, joins sources and blocks as before, and replays the exchange in front of it (or at the end when no prompt has carried it yet). A session without exchanges replays exactly as before. `SessionCatalog` gains optional `recordLocalExchange`, `takePendingLocalExchanges` and `loadLocalExchanges`.
