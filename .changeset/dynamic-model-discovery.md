---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": minor
---

Discover Anthropic models instead of hardcoding them, and add a settings screen
to curate the picker.

The Claude backend now reads the roster from the Models API (`GET /v1/models`),
working with either an API key or a `CLAUDE_CODE_OAUTH_TOKEN` subscription
token. Dated snapshot ids are canonicalized to their public alias
(`claude-haiku-4-5-20251001` → `claude-haiku-4-5`, validated against the API
before use), so the picker lists aliases only. Results are cached under
`$BRAIN_PATH/.brain-ui/anthropic-models.json` and refreshed lazily behind
requests, so a newly released model appears within the TTL without a restart or
an env edit. Discovery never blocks boot and degrades to the previous list —
or to declared profiles — when the API is unreachable.

- `@schlessera/brain-backend-claude`: new `createModelSource()` /
  `discoverAnthropicModels()`; `ClaudeBackendOptions.profiles` now also accepts
  a function so the roster can grow at runtime.
- `@schlessera/brain-ui-server`: `BRAIN_UI_MODEL_DISCOVERY` (default on, off
  under a test runner) and `BRAIN_UI_MODEL_TTL_HOURS` (default 24); new
  `GET /api/models`, `PUT /api/models/hidden`, `POST /api/models/refresh`; a
  `settings` KV table (migration 006) holding the hidden set. Hidden profiles
  are omitted from `/api/providers` but still resolve for sessions pinned to
  them.
- `@schlessera/brain-ui-react`: the Security panel becomes a tabbed **Settings**
  panel (Models | Security) with per-model visibility toggles and a manual
  refresh. `useUIStore`'s `securityPanelOpen`/`toggleSecurityPanel`/
  `setSecurityPanelOpen` are renamed to `settingsPanelOpen`/
  `toggleSettingsPanel`/`setSettingsPanelOpen`, plus `settingsTab`,
  `openSettings(tab)` and `setSettingsTab(tab)`.
- `@schlessera/brain-ui-sdk`: `ProviderInfo` gains optional `contextWindow` and
  `source`; new `ModelCatalogEntry` / `ModelCatalogResponse` /
  `SetHiddenModelsRequest`.

Also: the mobile tab bar drops Brief, gains New chat, and moves Sync, History
and Settings behind a "…" menu.
