---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Choose the default live-conversation service in Settings › Voice (#3616).

- **Server.** `createApp` accepts `conversationProviders` (several live services) and `defaultConversationProviderId`; `conversationProvider` still means a list of one. Startup fails on both options, duplicate ids or a default that is not registered. `GET`/`PUT /api/settings/voice` read and save the brain-wide default against its revision. Writing has its own owner-only guard: the owner's password or passkey session or the ambient human; anyone else gets 403 with an empty body. Unknown ids are 400 `LIVE_PROVIDER_UNKNOWN`, stale revisions 409 `LIVE_SETTINGS_CHANGED`.
- **Wire.** `server_hello` adds `conversationProfiles` and `liveDefault`, and sends `conversationProfile` only while a service is effective, so a single-provider host is unchanged. A save sends `live_settings` to open connections. `conversation_start` accepts `providerId`, which must equal the disclosed profile's; `conversation_opened` adds `providerSource`.
- **Selection.** A Start uses a one-time pick, else the saved default if it is still registered, else the host default or the only service when nothing is saved. A saved default that is no longer registered requires an explicit pick and is never replaced by the host default. A save applies from the next explicit Start; a running conversation and its reconnects keep their service. Nothing probes a credential, and saving opens no provider, microphone or history.
- **App.** Settings › Voice gains the Live service group (kit `LiveServiceSettings`), and the pre-Start disclosure sheet offers the one-time pick when several services are usable or the saved default is unavailable.
