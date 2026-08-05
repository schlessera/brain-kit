---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": minor
---

Extract the brain-ui deployment into two reusable packages.

- **New `@schlessera/brain-ui-server`**: Hono app factory (`createApp`) with
  auth (password/passkeys/tailscale/proxy), the WebSocket turn coordinator
  (decomposed into explicit host objects: `WsHost`, `TurnCoordinator`,
  `SessionCatalog`), session catalog with bundled SQLite migrations, brain/
  files/voice routes, and injected seams for the static client build and the
  PNG/PDF renderer.
- **New `@schlessera/brain-ui-react`**: the chat/files/voice React components,
  stores, and WS transport. The chat store now keeps a transcript buffer per
  session (plus a draft buffer), so background sessions accumulate instead of
  being discarded. Ships prebuilt JS + d.ts, a precompiled `styles.css`, and a
  `theme.css` source entry for Tailwind v4 consumers. Branding copy is
  configurable via `configureBrainUi()`.
- **ui-sdk**: add `PasskeySummary` to the protocol (REST payload of the
  passkey management routes, previously local to brain-ui).
