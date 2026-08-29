---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-pi": minor
---

Per-model reasoning effort, editable in Settings → Models.

- Effort-capable rows (the pi backend's profiles — Claude rows have no effort
  knob) get a tri-state effort select next to billing: "Default (<level>)"
  shows the configured level, an explicit pick is stored server-side
  (`PUT /api/models/thinking`, full record like hidden/billing) and applies
  to the NEXT new session — no env edit, no redeploy. Resumed sessions stay
  pinned.
- `ProviderInfo.thinkingLevel` (additive) carries the effective level, and
  its presence marks a profile as effort-capable; `ModelCatalogEntry` gains
  `thinkingOverride`. `ThinkingLevel`/`THINKING_LEVELS`/`isThinkingLevel`
  join the sdk protocol.
- `CreatePiBackendOptions.profiles` also accepts a function, re-read on every
  roster listing and model resolution, which is how the host applies settings
  overrides live.
