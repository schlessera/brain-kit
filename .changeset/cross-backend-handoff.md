---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Continue a conversation on another backend (#61). The locked model picker, a session row's overflow and the ⌘K palette open a review sheet that drafts a handoff summary with the source's own model (falling back to a draft from the last six messages), lets you edit it and pick references, and starts a new linked chat on the chosen backend. The source keeps its history, backend and accounting and shows a forward marker; the new chat opens with a handoff card linking back. Additive wire: `chat_message.handoff`, `handoff_prepare`/`handoff_prepare_cancel`/`handoff_status`, `handoff_draft`/`handoff_receipt`, message source `handoff` and `ChatSession.handoffFrom`. A repeated handoff key never creates a second session. `ModelPicker` gains an optional `lockedAction`.
