---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

- Define the four browser bridge tools once in the UI SDK while preserving Claude's names, descriptions, schemas, and result envelopes.
- Reject NUL, absolute, traversal-escape, and symlink-escape paths before either backend writes an image mask.
- Give pi's `ask_user` the full shared description, 1–4 question and 2–4 option bounds, a 12-character header bound, and optional option previews.
- Require pi's `ask_user.multiSelect` instead of defaulting it to `false`.
- Return pi's shared `ask_user` payload (echoed questions, answers, and annotations) to the model while keeping the full `AskUserResult` in details.
- Advertise and validate pi's `query_activity.scope` as the shared enum.
