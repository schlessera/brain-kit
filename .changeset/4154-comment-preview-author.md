---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

A GitHub comment's approval card now says who would post the comment and whether it goes on an issue or a pull request, when the host can verify each:

- **Who posts it:** the account the host's GitHub tools credential posts as. The host looks it up for that same credential and never shows one credential's account for another.
- **Where it goes:** the target's kind, read from GitHub for the card's own repository and number. This lookup asks the turn's data routing first, as a read does.
- **When the host cannot verify a fact:** the card shows "The host's GitHub account" and `owner/repo #number`, with no kind and no link. It never shows `@ghost` or a guessed kind, and the approval works as before.

These facts are only shown on the card. The approved content, the check that the approval was not edited, the tool's result and what the model sees are unchanged.

- **Wire and server SDK:** `tool_approval_request` and `PermissionRequest` gain the optional `display` field (`ApprovalDisplay`).
- **Kit:** `GitHubComment` in `preview` accepts no `author` and shows its whole draft. `GitHubRef` accepts `kind: null`.
