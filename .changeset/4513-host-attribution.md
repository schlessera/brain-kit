---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

The host now decides tool attribution for safety inputs. When its collector observes differently named calls under one tool-use ID in a turn, nested calls included, it records that fact durably, and session safety history readers that opt in (`attribution=1`, or `includeAttribution` on `safety_read` when the server advertises `sessionSafetyAttribution`) receive an `attribution` record. The safety review then shows the action as unknown. The client no longer infers attribution from its own transcript.
