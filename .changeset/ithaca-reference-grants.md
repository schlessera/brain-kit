---
"@schlessera/brain-ui-server": minor
---

Add owner-managed reference-source grants. In password mode an owner can grant a live principal a repository prefix and a named existing host credential (`BRAIN_UI_SYNC_GITHUB_TOKEN`, `BRAIN_UI_SKILLS_GITHUB_TOKEN`, `GITHUB_TOKEN` or none) through `GET`/`POST /api/auth/principals/:id/reference-grants`, and revoke one with `DELETE /api/auth/principals/:id/reference-grants/:grantId`. Grants become the only authority for private reference acquisition. A configured host credential never grants access by itself, and revoking a grant or its principal applies to the next authority check.
