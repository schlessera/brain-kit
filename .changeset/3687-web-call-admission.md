---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-pi": minor
---

Admit each web provider request for the calling turn. Pi's web tools now check the conversation's provider policy and the turn's budgets before a named provider is called, and again for every request the web executor sends to a provider's API, including extraction fallbacks and nested model calls. A refusal answers `policy_denied` or `budget_exceeded`, and each admitted request counts as unknown spend in the turn, conversation and day budgets, never as zero.
