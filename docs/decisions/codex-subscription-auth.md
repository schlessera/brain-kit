# Separate ChatGPT grants for pi and the Codex CLI

**Decided by the maintainer, 2026-10-06.** The [O2 ruling](https://github.com/schlessera/brain-kit/issues/1000#issuecomment-6020618855)
accepts source evidence of refresh-token rotation and reuse detection as enough
to reject a shared grant. The [separate-login receipt](https://github.com/schlessera/brain-kit/issues/1000#issuecomment-6020658276)
provides the observation that a second device-code login can coexist with pi.
[#1000](https://github.com/schlessera/brain-kit/issues/1000) owns this investigation.

## Credential ownership

A ChatGPT account can authorize both clients, but each client must obtain and
manage its own OAuth grant. Do not copy, derive or synchronize pi's
`openai-codex` tokens into the Codex CLI's credential store. A connected pi
account does not establish that the Codex CLI is connected, and the reverse is
also true. Account identity and credential identity are different facts.

Pi owns its login, refresh and locked credential persistence. Brain-kit's
existing service drives `ModelRuntime.login`; it does not implement OAuth
exchange or refresh itself. The credential store is `auth.json` under the pi
agent directory, normally `~/.pi/agent`, with `PI_CODING_AGENT_DIR` overriding
that directory. The subscription-profile availability check reads that same
store (`hasStoredCredential`, `packages/ui-backend-pi/src/auth.ts:125-127`).

The Codex CLI obtains a separate grant through `codex login --device-auth`.
Its native credential storage remains its own responsibility. With file-based
storage, the credential is `$CODEX_HOME/auth.json`; `CODEX_HOME` defaults to
`~/.codex`. Native `keyring`, `auto` and `ephemeral` storage modes have different
persistence behavior, so the existence of that file is not a general login
status test. [Official authentication guidance](https://learn.chatgpt.com/docs/auth#credential-storage)
describes these modes and [headless device-code login](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).
The host must give the native process the intended home and storage mode;
this decision does not select a hosting layout or persistence mechanism.

## Why sharing a grant is unsafe

Source inspected for the versions in the receipt:

- The npm `@earendil-works/pi-ai` 0.87.1 package reports git revision
  `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`.
  [`readTokenResponse` and `refreshAccessToken`](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/ai/src/auth/oauth/openai-codex.ts)
  require a refresh token in the response and return it as the replacement
  credential. They do not preserve the previous refresh token.
- Codex CLI 0.160.0 resolves to revision
  `a956835d020762cb2b570053af06f643a11c0ecc`.
  Its [refresh failure classifier](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/login/src/auth/manager.rs)
  handles `refresh_token_reused` and `refresh_token_invalidated` as terminal
  exhaustion or revocation requiring another login.

The inference is that two independent refresh owners sharing a rotating grant
can invalidate one another. The maintainer accepted this as sufficient evidence
for the no-sharing policy. A deliberate shared-token reuse experiment was not
performed and is not claimed as an observation.

## What the separate-login measurement showed

The maintainer's sanitized receipt used pi / pi-ai 0.87.1 and Codex CLI 0.160.0
in a scratch environment with separate pi and Codex homes:

| Observation | Result |
| --- | --- |
| Pi `openai-codex` device-code login | Succeeded. |
| Separate `codex login --device-auth` | Succeeded. |
| Account identity and grants | Same account; distinct refresh tokens. |
| Codex model call using its own credential | Succeeded. |
| Pi refresh forced by expired credential, then pi model call | Succeeded; pi refresh token changed. |
| Codex model call after that pi refresh | Succeeded. |
| Second forced pi refresh and model call | Succeeded. |

A forced Codex refresh was **not observed**: backdating `last_refresh` did not
trigger one in 0.160.0, and its refresh token did not change. The ruling does not
require that experiment. This receipt supports separate-login feasibility for
the recorded versions; it does not certify all future versions, renewal
lifetimes, revocation behavior, account entitlements or a production rollout.
No new account access or inference was performed while writing this record.

## Consequences for the product

A Settings login for the Codex CLI must create a distinct native device-code
flow and expose its own connection state, even if the user chooses the same
ChatGPT account. Native client credentials remain private to their owners;
responses, logs and documentation must not expose tokens or account identifiers.
Pi's existing Accounts flow remains the entry point for pi only
(`createPiAuthRoutes`, `packages/ui-server/src/routes/pi-auth.ts:60-61`;
`PiAccountsSection`, `packages/ui-react/src/components/settings/pi-accounts.tsx:19-24`).

This is a go for implementing a separate Codex login in that Settings area,
not authorization to share a credential, add a Codex chat backend or select
API-key authentication automatically. The [Settings implementation task](https://github.com/schlessera/brain-kit/issues/1271)
owns the native transport, user interaction and runtime proof. The hosting template owns CLI
installation and persistent storage; this record introduces no environment or
HTTP contract. Existing pi profiles, account connection and API-key behavior
remain unchanged.
