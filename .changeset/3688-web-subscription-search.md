---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-pi": minor
---

Pi's web search can use the turn's own model. A Pi turn whose inference runs on the host relay lends its admitted model to the web tools, so OpenAI search works on that turn's ChatGPT/Codex login or on the current model. The host resolves and refreshes the credential on every request, the web executor holds only a placeholder, and a search for any other model is refused before anything is sent. The SDK's `WebToolCall` gains an optional `model`, set through a new optional argument of `handleWebTool`.
