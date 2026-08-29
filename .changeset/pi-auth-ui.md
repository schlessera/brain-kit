---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Sign in to pi model providers from Settings — no shell on the host needed.

- `@schlessera/brain-backend-pi` exports `createPiAuth()`: a headless OAuth
  service over pi's `ModelRuntime.login` that answers the method prompt with
  the device-code flow (the browser flow would bind a callback port on the
  server), captures the user code from the auth event stream, and exposes a
  start/poll/cancel/logout surface. Credentials persist through pi's own
  locked store (`~/.pi/agent/auth.json`, `PI_CODING_AGENT_DIR` aware), so a
  login is immediately visible to the chat backend.
- ui-server mounts `/api/pi-auth/*` behind the auth guard, lazily loading the
  optional pi package; provider ids are validated against the configured
  roster's vendors, and the endpoints report an empty provider list when pi
  is not in play.
- Settings → Models grows an **Accounts** section (hidden on Claude-only
  deployments): Connect shows the device code and verification link, polls to
  completion, and Disconnect removes the stored credential. This is the
  intended path for connecting OpenAI (ChatGPT Plus/Pro) for the
  `openai-codex` gpt profiles.
