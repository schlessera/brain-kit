# @schlessera/brain-backend-claude

## 0.7.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain-ui-sdk@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.3

## 0.6.2

### Patch Changes

- eb0a6ba: Auto-allow the brain's own MCP document tools in the Claude backend

  `DEFAULT_ALLOWED_TOOLS` now covers `mcp__brain__brain_{search,context,read,list,graph,add,update}`.
  Since the brain repo started registering the CLI's MCP server project-scoped in
  `.mcp.json`, those tools reached the model but were absent from the allowlist,
  so every `brain_read` raised an approval card. `Write` and `Edit` were already
  auto-allowed, so withholding `brain_add`/`brain_update` only pushed the model
  onto the raw-file path, which skips frontmatter and the reindex.

  `brain_archive` stays behind an approval card — it moves files between
  directories.

  Also fixes a latent write-serialization gap: all three brain writers are now in
  `MUTATING_TOOLS`, so they take the cross-session write lock like `Edit` and
  `Write`. Previously two parallel sessions could reindex the repo concurrently.

  - @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.0

## 0.5.1

### Patch Changes

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

### Patch Changes

- Updated dependencies [2c42696]
  - @schlessera/brain-ui-sdk@1.0.0

## 0.3.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain-ui-sdk@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain-ui-sdk@0.2.0
