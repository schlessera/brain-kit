---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

The host now decides tool attribution for safety inputs. When its collector observes differently named calls under one tool-use ID in a turn, nested calls included, it records that fact durably, and session safety history readers that opt in (`attribution=1`, or `includeAttribution` on `safety_read` when the server advertises `sessionSafetyAttribution`) receive an `attribution` record. The safety review then shows the action as unknown, and names no action while the history is still loading. Attribution is display-only: a fact that cannot be written yet is served from memory and retried, never restricting the chat; past the tracking limits one fact covers every ID in the turn; facts count against the history ceilings; a fallback tool name is not a second name. The client no longer infers attribution from its own transcript.
