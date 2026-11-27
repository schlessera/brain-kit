---
"@schlessera/brain-backend-claude": patch
---

The Claude backend's per-turn `capabilities` host fact now reports `apify`, `attachments`, `github` and `turnTemp`, the keys pi already reports, after the existing keys (#4719). The model on a Claude session is now told when the GitHub, Apify or attachment handlers become unavailable or available again. An existing session receives one `capabilities:` line in the host-context block of its next new user message; no earlier message, tool or system prompt changes.
