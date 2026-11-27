---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

`@schlessera/brain-ui-sdk/server` exports the experimental backend toolkit helpers `isSessionUuid`, `autonomousYieldLatch` and `usageTokenCount` (#4721), and both backends use them for the session-id test, the autonomous yield wrapper and the `first_request_cache` token check instead of their own copies. The Pi backend's transcript writer now refuses a session id that is not a UUID, as the rest of the package already did; its callers pass server-minted UUIDs.
