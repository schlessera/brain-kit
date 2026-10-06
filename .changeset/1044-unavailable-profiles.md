---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-react": minor
---

Show configured profiles that cannot run now, with their reason, in the handoff sheet. `AgentBackend` gains an optional `listUnavailableProfiles()` returning `{ id, label, reason }`, with `reason` from the closed `PROFILE_UNAVAILABLE_REASONS` enum (`needs-credentials`). The Claude backend reports a profile whose required environment key is missing; pi lists every configured profile and omits the member. `GET /api/providers` gains an optional `unavailable` list beside `providers`, absent when empty: the runnable roster, routing and handoff resolution are unchanged, and the host drops any entry whose reason is not in the enum, so no key name or other backend text reaches a client. The handoff sheet's To list shows these profiles on other backends after the runnable ones, disabled and reading `needs credentials`; they cannot be chosen.
