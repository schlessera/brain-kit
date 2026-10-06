---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Add the live-conversation host contract (#957). `@schlessera/brain-ui-sdk/server`
exports the experimental `LiveConversationProvider` seam with runtime
validation, and the protocol gains the additive, negotiated `conversation_*`
frames and `tool_resolution`. `createApp({ conversationProvider })` registers a
provider beside dictation: the host admits work only on a client's semantic
commit, runs it through the ordinary backend with the voice posture
(new `StartTurnRequest.posture: "voice"`: Claude selects `VOICE_ALLOWED_TOOLS`,
pi refuses the turn), never
publishes a result for a cancelled, withdrawn or replaced request, and keeps a
once-only permission announcement ledger across epochs. Clients that declare
`toolResolution` learn whether a permission request was granted, denied,
expired with its turn, or unknown. Legacy and rev-3 clients see no change.
No provider adapter ships.
