---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

`historyCoverage` on `conversation_opened` and `LiveConversationSession` gains an optional `includedMessages`: how many prior chat and spoken messages the live startup context actually carried (completed results and gap markers are not counted). The server reports it for both built-in engines, and the live conversation's inline chat notice now reads "Started with the last {n} messages · Details", keeping the coverage-state wording for older hosts that omit the count. The count is host-only display data and never reaches the voice provider (#3699).
