# @schlessera/brain-backend-pi

## 0.14.0

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
  - Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
    (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
    two differently-configured apps coexist in one process.
  - Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
    `schema_version`; `assertBackendResolvable` refuses to boot when the selected
    agent backend is not installed.
  - Changed: `@schlessera/brain-backend-claude` is an optional peer of
    `ui-server`, not a dependency — a deployment declares the backend it uses.
  - Changed: the module contract carries the config generic through
    `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
    longer casts a value the loader already validated.
  - Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
    around client construction.
  - Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
    `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
    namespace and the `getBackends`/`getBackendsInfo` module functions — their
    replacements live on the app handle.

### Patch Changes

- Updated dependencies [59de559]
  - @schlessera/brain@0.14.0
  - @schlessera/brain-ui-sdk@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [01004ef]
  - @schlessera/brain@0.13.1
  - @schlessera/brain-ui-sdk@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [a4eb4d0]
- Updated dependencies [fc5c897]
- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
  - @schlessera/brain@0.13.0
  - @schlessera/brain-ui-sdk@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain@0.12.1
- @schlessera/brain-ui-sdk@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [4281c59]
  - @schlessera/brain@0.12.0
  - @schlessera/brain-ui-sdk@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [604abbc]
- Updated dependencies [cdfa039]
  - @schlessera/brain-ui-sdk@0.11.0
  - @schlessera/brain@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [e6f55e0]
- Updated dependencies [e33db75]
- Updated dependencies [50f6ec7]
- Updated dependencies [683f3e3]
- Updated dependencies [fc79a8f]
  - @schlessera/brain@0.10.0
  - @schlessera/brain-ui-sdk@0.10.0

## 0.9.0

### Minor Changes

- 1f7e6a3: Added: mermaid diagrams get their own share menu (PNG / PDF / SVG / source) and a
  full-screen pan-and-zoom viewer, opened by tapping the diagram.
  Added: a chat-surface brief appended to the agent's system prompt —
  `buildSystemPromptAppend({ client, tools })` — covering diagrams, `<share>`
  blocks, wikilinks, raw-HTML and tool-narration rules, the ask-user and location
  tools, and what the reader's device can do. Each backend declares its own tool
  names (pi has no location tool), and both take a `systemPromptAppend` option to
  override the whole brief.
  Added: `chat_message` frames carry an optional `client` field
  (`ClientEnvironment`: form factor, touch, standalone, camera, microphone,
  geolocation, share sheet, viewport, locale, timezone), feature-detected in the
  browser and validated strictly at the boundary. The Claude backend rebuilds its
  system-prompt append per turn from it.
  Changed: diagrams render in a theme built from the app's own tokens instead of
  mermaid's stock dark/neutral themes; exports use the matching light theme.
  Changed: `MermaidTheme` is now `"dark" | "light"` (was `"dark" | "neutral"`),
  `ShareMenu`'s `renderTrigger` also receives `status` and `icon`, and the
  server-internal `handleChatMessage` takes an options object.

### Patch Changes

- Updated dependencies [1f7e6a3]
  - @schlessera/brain-ui-sdk@0.9.0
  - @schlessera/brain@0.9.0

## 0.8.0

### Patch Changes

- @schlessera/brain@0.8.0
- @schlessera/brain-ui-sdk@0.8.0

## 0.7.2

### Patch Changes

- @schlessera/brain@0.7.2
- @schlessera/brain-ui-sdk@0.7.2

## 0.7.1

### Patch Changes

- @schlessera/brain@0.7.1
- @schlessera/brain-ui-sdk@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain@0.7.0
  - @schlessera/brain-ui-sdk@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain@0.6.3
- @schlessera/brain-ui-sdk@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain@0.6.2
- @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [89d8a72]
  - @schlessera/brain@0.6.1
  - @schlessera/brain-ui-sdk@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain@0.6.0
- @schlessera/brain-ui-sdk@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain@0.5.1
- @schlessera/brain-ui-sdk@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [2904074]
  - @schlessera/brain-ui-sdk@0.5.0
  - @schlessera/brain@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [2c42696]
  - @schlessera/brain-ui-sdk@1.0.0
  - @schlessera/brain@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [9e4668b]
- Updated dependencies [e08752c]
  - @schlessera/brain@0.3.0
  - @schlessera/brain-ui-sdk@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain@0.2.1
  - @schlessera/brain-ui-sdk@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain@0.2.0
  - @schlessera/brain-ui-sdk@0.2.0
