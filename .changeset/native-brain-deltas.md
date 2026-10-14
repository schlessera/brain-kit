---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Replace repeated whole-brain journal and worker input copies with managed Btrfs checkpoints and changed-only retained history. Hosted apps now require a qualified native storage service and explicit finite volume capacity; unsupported storage refuses with setup guidance instead of a copy fallback. The retained history limit remains 10 GiB and staged worker outputs keep their existing allowance.
