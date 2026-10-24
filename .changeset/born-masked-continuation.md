---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
---

A hosted turn whose governance policy masks a provider folder no longer receives the brain's saved Claude auto-memory and saves no note to it (#2726). It continues an existing conversation, or a handoff from one, only when the server recorded that the conversation was born with those folders masked and kept them masked on every turn since. A conversation from before the provider rule, from a route that could see the folder, or without that record is refused before its history is copied or sent, with an actionable request to start a new conversation, and drafting its handoff summary is refused. Saved memory and transcripts are never changed. Expect existing conversations to need a fresh start the first time you add a provider rule.
