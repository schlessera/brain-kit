---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-pi": minor
---

Run the pi backend alongside Claude, with declared model profiles — the path
to OpenAI models under a ChatGPT subscription.

- New `BRAIN_UI_PI_PROFILES` env var (JSON array of
  `{id,label,vendor,model,thinkingLevel?}`): when set with the default
  `AGENT_BACKEND=claude`, the pi backend joins the registry and its profiles
  join the picker. pi-ai's built-in `openai-codex` vendor authenticates only
  via ChatGPT Plus/Pro OAuth (`pi login`, device-code capable), so e.g.
  `{"id":"gpt-sol","label":"GPT-5.6 Sol","vendor":"openai-codex","model":"gpt-5.6-sol","thinkingLevel":"xhigh"}`
  runs on the subscription, not API tokens.
- Fail-loud everywhere a wrong-but-plausible default could hide: malformed
  profiles JSON, duplicate/reserved ids (`default`, `claude`, `claude-*`),
  and invalid thinking levels refuse at boot; a missing pi package with the
  variable set refuses at boot; a declared vendor/model absent from pi's
  catalog rejects the turn instead of letting pi pick a provider; a resume
  whose saved model is unavailable rejects instead of silently substituting.
- Billing classification keys on the profile vendor: `openai-codex` →
  subscription, other pi vendors (ambient API keys) → api. Claude
  classification is unchanged.
- `PiProfile` gains `thinkingLevel` (passed to new sessions; pi clamps to the
  model's capability).
