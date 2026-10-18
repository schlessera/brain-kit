---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-ui-server": patch
---

Retain Claude-generated session titles while attributing measured title-helper usage separately from main-conversation and cache diagnostics. Reconcile supported OTLP receipts within the existing cumulative accounting transaction so helper spend appears once, preserve unmatched usage as unattributed, and respect configured operator telemetry and opt-outs.
