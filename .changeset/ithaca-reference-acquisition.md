---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

Acquire shared reference source through the native reference pool. Public source is resolved and fetched anonymously and shared across the host; private source needs a live owner-managed grant and stays with its principal. Only the network transport ever holds the granted credential, and checkout runs with no credential and no network. Authority validation and refresh keep separate request-only clocks (`BRAIN_UI_REFERENCE_VALIDATION_SECONDS`, `BRAIN_UI_REFERENCE_REFRESH_SECONDS`, five minutes each). A failed refresh returns the previous revision explicitly stale while its authority is still valid. At most `BRAIN_UI_REFERENCE_ACQUISITIONS` (two) operations run host-wide, and same-source requests join one. Capacity pressure evicts the least recently used source no reader holds. Revocation cancels and withdraws private source. `ServerConfig` gains optional `referenceSource`, and transport workers can run without network.
