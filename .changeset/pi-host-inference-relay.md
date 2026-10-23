---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": patch
---

On hosts with managed native storage, governed and strict pi turns now run on the turn egress proxy and the host inference relay, like Claude turns. The worker holds only a placeholder: on each request the host asks pi's own credential store, so refresh and its writeback happen on the host. Every connection is a governance event, and outward hosts wait for approval. Variables that name or feed the provider's credential stay on the host, so the `brain` CLI inside that worker no longer sees them either, until its own providers are relayed (#1673).

The relay carries API keys on Anthropic Messages and OpenAI-compatible models, and the `openai-codex` (SSE) and `anthropic` logins. A credential can reach only its provider's built-in origins and any exact origins listed for that provider in the new server variable `BRAIN_UI_PI_CREDENTIAL_ORIGINS` (`provider=origin[,origin];...`).

**Reduced capability, by maintainer ruling:** on those hosts, a pi turn is refused before its worker starts, with the reason, when its key or a header runs a command (`!command`), when it uses another provider login (such as GitHub Copilot), a login implementation configured in `models.json` (`oauth`) or another provider API, when pi's `auth.json` is linked into the brain, or when a `models.json` linked into the brain holds a literal key. Before this change those turns ran with the credential inside the worker.

**Migration:** if pi's `models.json` points a provider at a custom origin, add that origin to `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, for example `anthropic=https://gateway.ithaca.invalid`. Replace a command-sourced key with a literal, an environment variable or a stored key.
