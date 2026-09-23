---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain": minor
---

A Claude turn on a profile without its own credential now runs on the
subscription or not at all. Claude Code prefers an `ANTHROPIC_API_KEY` over
`CLAUDE_CODE_OAUTH_TOKEN`, silently, when both are in its environment; it also
takes a key from an `apiKeyHelper` or a stored Console login. So such a turn now
runs with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` cleared and any
`apiKeyHelper` switched off. The CLI's account is checked before the prompt is
sent, and a turn with no subscription login ends with a `CLAUDE_AUTH` error
instead of billing a key. The core CLI's `claude` agent runner (what `brain
sync` uses) follows the same rule. Model discovery prefers the subscription
token too.

What a host may need to change:

- **Billing an API key for chat on purpose?** Declare a profile that names it,
  e.g. `BRAIN_UI_CLAUDE_PROFILES='[{"id":"claude-api","label":"Claude (API)","apiKeyEnv":"ANTHROPIC_API_KEY"}]'`.
  Credential-free profiles no longer use the ambient key, and are now always
  classified as subscription-billed.
- **`brain sync` under cron ran on an API key?** It now needs a subscription
  login (`CLAUDE_CODE_OAUTH_TOKEN`).
- **`anthropic-haiku` completions inside chat turns?** Name the key separately:
  `completions: { provider: "anthropic-haiku", apiKeyEnv: "BRAIN_ANTHROPIC_COMPLETIONS_KEY" }`,
  and admit that name to the agent with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`.
  `completions.apiKeyEnv` and `completions.fallbackApiKeyEnv` are new.
