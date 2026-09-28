---
"@schlessera/brain-ui-react": minor
---

A dictated message keeps its dictation badge after a reload or on another device (#549). The composer, the ask-user re-ask and share intake send `source` on every `chat_message`, and a replayed user message takes its `source` from history, defaulting to `typed`.
