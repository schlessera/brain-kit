---
"@schlessera/brain-ui-sdk": minor
---

`chat_message` and replayed history messages carry an optional `source` (`typed` | `voice-dictate` | `voice-conversation`), so how a user message was produced survives a reload (#549). `ClientChatMessage.source` says how the client's user produced the message; `SessionHistoryMessage.source` returns it on a replayed `role: "user"` message. Both are additive: absent means `typed`, and a value the receiver does not know reads as absent instead of failing the frame. `messageSourceSchema` is exported from `@schlessera/brain-ui-sdk/schemas`.
