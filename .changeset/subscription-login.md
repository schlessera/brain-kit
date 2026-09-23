---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-sdk": minor
---

The Claude subscription token is minted off the host and rotated by redeploy. The procedure is in `docs/hosting/README.md`, "Claude subscription login". The server's side of it:

- `BRAIN_UI_CLAUDE_TOKEN_MINTED_AT` records the date the token was minted. It is server-only and set next to the token. From 30 days before the one-year expiry, the server logs a WARN at boot and at most once a day. A token without the date gets one WARN at boot saying the server cannot warn. A date the server cannot read refuses the boot.
- `/api/status` gains a `subscription` object: `tokenSet` (never the token itself), `mintedAt`, `expiresAt`, and `lastProvenAt` / `provenBy`. The last proof is either the latest successful turn on the subscription, read from the activity store, or a successful model-discovery call with the token. The object also carries `lastAuthFailure` with an `action`.
- Every auth failure logs one WARN with the instruction for it. `relogin` covers a rejected token or a 401 from model discovery. `check_account` covers `oauth_org_not_allowed`, `account_on_hold` and `billing_error`, which a new token will not fix. `runtime.lastAuthFailure` carries the same `action`.
- `@schlessera/brain-ui-sdk` exports `subscriptionAuthAction` and `SUBSCRIPTION_AUTH_INSTRUCTIONS`. `BackendModelSourceState` gains `subscriptionProvenAt` and `subscriptionRefused`.
- The server README's `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` rows now say what those variables do.
