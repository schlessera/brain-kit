# @schlessera/brain-ui-react

## 0.6.3

### Patch Changes

- Fix Deepgram voice input: present the minted token as `bearer`, not `token`

  The server mints a short-lived `/v1/auth/grant` access token, but the client
  still offered it with the raw-API-key subprotocol scheme
  (`["token", …]`). Deepgram rejects that handshake outright — no 101, close code
  1002 — so the mic sheet opened, the recorder started, and the sheet closed again
  a moment later with no transcript. Voice has been broken this way since the
  grant-only change removed the master-key fallback: that change swapped the
  credential type without swapping the scheme word.

  - @schlessera/brain-ui-sdk@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.1

## 0.6.0

### Minor Changes

- The Search and Add quick actions do something now. Both were stubs that cleared
  the composer and focused it, so the "Search..." card on the new-conversation
  screen (and `/search`, `/add` in the command palette) looked like a no-op that
  dropped you into an empty chat.

  - **Search** opens a panel that queries `brain search` as you type (debounced,
    superseded requests aborted), highlights the matched terms, strips the
    markdown noise out of snippets, and opens the hit in the file viewer. Arrow
    keys pick, Enter opens. Degraded-mode warnings from the CLI are shown.
  - **Add** opens a form — note, optional title, type (completed from the types
    already in the brain) and tags — and posts it to `brain add`.

  Both talk to the brain CLI over REST rather than to the agent, so they stay
  available while a turn is streaming or the socket is down.

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.0

## 0.5.1

### Patch Changes

- - Fixed: hiding or unhiding a model in Settings → Models now updates the
    composer's model picker immediately, instead of only after a page reload.
  - Fixed: a session pinned to a hidden model showed "Default model" in the
    picker; it shows the pinned model's id.
  - @schlessera/brain-ui-sdk@0.5.1

## 0.5.0

### Minor Changes

- 2904074: - Added: the model picker is discovered from the Anthropic Models API, so a new
  model appears without an env edit or a redeploy.
  - Added: a Settings screen (Models | Security) to hide models from the picker
    and refresh the list on demand.
  - Added: `BRAIN_UI_MODEL_DISCOVERY` and `BRAIN_UI_MODEL_TTL_HOURS`.
  - Changed: `BRAIN_UI_CLAUDE_PROFILES` is now only for non-Anthropic endpoints
    and for overriding a discovered model.
  - Changed: `useUIStore`'s `securityPanelOpen` / `toggleSecurityPanel` /
    `setSecurityPanelOpen` are now `settingsPanelOpen` / `toggleSettingsPanel` /
    `setSettingsPanelOpen`.

### Patch Changes

- Updated dependencies [2904074]
  - @schlessera/brain-ui-sdk@0.5.0

## 0.4.0

### Minor Changes

- 2c42696: Extract the brain-ui deployment into two reusable packages.

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

### Patch Changes

- Updated dependencies [2c42696]
  - @schlessera/brain-ui-sdk@1.0.0
