---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A turn that declares `noGrantSurface` without `enforceAllowedTools` is now refused.

- Added: `assertTurnPosture(req)` in `@schlessera/brain-ui-sdk/server`.
- Changed: both backends' `startTurn` reject that request with a `BackendRequestError` before anything is emitted. A turn declaring both, `enforceAllowedTools` alone, or neither is unchanged.
