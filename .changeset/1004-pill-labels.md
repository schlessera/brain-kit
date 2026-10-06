---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Label pending follow-up and working-session pills with a few words from a small, fast model. A host that passes `createApp({ labeller: { provider } })`, with any value of core's `CompletionProvider` shape, gets a 2–4 word label for each queued follow-up (on `QueuedFollowUpView.label`, sent again in `session_queue` when it arrives) and for each session's latest request (on `ChatSession.label` in `GET /api/sessions`, stored so a reload or restart reuses it). Labels are plain text of at most `PILL_LABEL_MAX_CHARS` (32) characters. Pills render at once with their fallback, the session title or the start of the prompt, and keep it when the labeller is off, which is the default, or fails. With a labeller set, the text of every queued follow-up and turn request goes to its provider, which may be a different vendor from the session's backend. Calls are counted in `brain.labeller.calls`; the provider reports no usage, so their cost is unknown. The app's pending follow-up pills print the host's label when there is one.
