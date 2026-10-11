---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-sdk": patch
---

Scope Claude worker state to the resumed conversation, reserve tmpfs headroom before copying, and offer a reviewed handoff when a session is too large. Automatically archive idle transcripts after 30 days and restore archived history and resumes transparently. Refuse oversized pi sessions before launch with growth headroom and classify snapshot overflow as `session_too_large`. Register `session_too_large` in `FIRST_PARTY_FAILURE_CLASSES`, so a reviewed report keeps the class.
