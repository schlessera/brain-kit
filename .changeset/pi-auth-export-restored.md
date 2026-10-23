---
"@schlessera/brain-backend-pi": minor
---

Restore `createPiAuth` and its types on the `@schlessera/brain-backend-pi` root. The curated exports in 0.41.0 removed it, so every Pi sign-in route in Settings (`/api/pi-auth/*`) failed with "does not export createPiAuth". The routes now load the real service again.
