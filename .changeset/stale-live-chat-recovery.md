---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Validate retained chat identities before session recovery or live voice admission. Missing chats report a scoped SESSION_NOT_FOUND error and offer explicit New conversation recovery while preserving unsent drafts. Known chats and imported-history recovery remain supported, with no implicit replacement or replay of failed work.
