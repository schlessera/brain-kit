---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A hosted turn now sees the provider folders its governance policy allows for the provider that actually receives its inference (#2695). Until now every turn under a `providers` rule had those folders masked. The recipient is named only from the exact origin the turn's host inference relay forwards to, which runs for governed and strict Claude and pi turns on managed native storage. Built-in vendor origins name their vendor, for example `https://api.anthropic.com` is `anthropic` and pi's `openai-codex` is `openai`. The new server variable `BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS` (`name=origin[,origin];...`) names a trusted gateway. Any other origin is unknown and sees no provider folder. That includes a custom base URL, an origin listed only in `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` or `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, routers, and Bedrock or Vertex.

A turn allowed every provider folder sees them, `.git` and the real search index. A turn allowed some of them gets masks for the rest and a private index without their documents. The turn's relay then refuses any other origin.

A conversation that showed folders to one recipient refuses a later turn, or a handoff, whose recipient may not see them, with `ProviderRecipientRefusedError`. That covers a pin that fell back to another profile, a changed route or a pi model change. A handoff summary is not drafted for such a conversation; write it by hand.

`AgentBackend` gains optional `inferenceOrigin({ profileId, sessionId })`, which the Claude and pi backends implement. A backend without it keeps every provider folder masked.
