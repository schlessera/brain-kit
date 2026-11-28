---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

The host now decides tool attribution for safety inputs. Its collector notes every tool name it observes under each tool-use ID of a turn, nested calls included, and the collection's end stores which IDs carried two names. Session safety history readers that opt in (`attribution=1`, or `includeAttribution` on `safety_read` when the server advertises `sessionSafetyAttribution`) receive `attributionUnknown` in the projection, and the safety review shows the action as unknown. Past 8 reused or 2,000 tracked IDs the whole turn reads as unknown. A turn never checked (from before this release, or ended by a restart) reads as before. The field is display-only and never changes enforcement. The client no longer infers attribution from its own transcript.
