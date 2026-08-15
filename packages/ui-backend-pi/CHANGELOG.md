# @schlessera/brain-backend-pi

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
