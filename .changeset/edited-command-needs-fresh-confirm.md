---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

An approval that edits a confirmed shell command into a different command that still needs confirmation is now refused.

- Changed: `checkEditedApproval` identifies a shell confirmation by the command text as well as the pattern. `brain archive a.md` can no longer be approved as `brain archive b.md`, and a narrower command (`rm -rf notes` → `rm -rf notes/old`) must be re-issued and confirmed as it is. An edit that needs no confirmation of its own is still applied.
- Changed: an edited input carrying an own `__proto__` key is refused on both backends, instead of being merged into the tool arguments.
