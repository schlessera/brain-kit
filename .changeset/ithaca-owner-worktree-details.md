---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

Let the owner read a private managed-worktree finding's details from its hygiene review card. The review read says per request whether this caller may read them, and `GET /api/hygiene/review/details/:itemId` returns the recorded owner, repository, revision, starting commit and changed paths to the owner principal only; every delegated agent and ambient principal is refused, and the replicated card stays opaque. `HygieneCard` gains a `details` slot, and the full card shows an inline Private details disclosure that fetches on opening and keeps the details in memory only.
