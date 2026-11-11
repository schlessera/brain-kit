---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Live conversation gains personas (#3617). A persona is Markdown at `_voice/personas/<id>.md` in the brain, with a name, one voice per live service and plain-text speaking-style instructions; Settings › Voice lists, edits and selects them, and the built-in Standard keeps today's exact behaviour. New owner-only routes `GET/POST /api/voice/personas`, `GET/PUT/DELETE /api/voice/personas/:id` and `GET/PUT /api/settings/voice` use sha-256 file revisions and a separately revisioned `voice.live.persona` setting. `LiveConversationProvider` gains optional `voices`, `defaultVoice` and `personaInstructionBytes` (mirrored on `ConversationProfile`, outside the Start disclosure echo), `LiveConversationOpenOptions` gains `persona`, `server_hello` gains `livePersona`, a new `live_persona` frame pushes changes, and `conversation_start` gains `personaRef` with an explicit one-time `voice: "default"`. Each conversation freezes its persona at Start; GPT-Live caps instructions at 2,000 UTF-8 bytes and Gemini Live at 6,000, refusing Start rather than truncating. Core now excludes `_voice` from the content index by default, so existing brains drop persona files from search on the next `brain index`.
