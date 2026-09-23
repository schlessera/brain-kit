---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

An approval decision records the channel it was made on. `tool_approval` and
`tool_denial` gain an optional `channel` (`card` | `voice`), stored on the
`approval_decision` activity event; the host refuses a voice-attributed grant
and leaves the request pending; the web client's approval cards send `card`;
and a resolved approval in Actions reads as the decision and its channel
("Denied by voice").
