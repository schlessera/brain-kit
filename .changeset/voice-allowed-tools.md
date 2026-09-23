---
"@schlessera/brain-backend-claude": minor
---

- Added: `VOICE_ALLOWED_TOOLS`, the named tool set a spoken turn runs under (docs/decisions/voice-permission.md). Selected as a turn's allowlist together with `enforceAllowedTools` and `noGrantSurface`, it denies `Bash` without raising a card and keeps `brain_add` and `brain_update`.
