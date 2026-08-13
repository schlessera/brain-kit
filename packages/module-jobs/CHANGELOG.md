# @schlessera/brain-module-jobs

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [89d8a72]
  - @schlessera/brain@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain@0.5.1

## 0.5.0

### Patch Changes

- @schlessera/brain@0.5.0

## 0.4.0

### Patch Changes

- @schlessera/brain@1.0.0

## 0.3.0

### Minor Changes

- 0eb1b03: Ship three skills and make `jobs scrape` cover both source kinds in one run.

  - **Skills** (`jobs-review`, `research-opportunity`, `interview-scheduled`) — the
    module shipped a CLI and no skills, so the conversational half of the workflow
    lived only in the reference brain. Generalized: no personal names, CV variants,
    or example slugs, and they read the configured `criteria` file and
    `opportunitiesDir` rather than hardcoded paths.
  - **`scrape --browser` is now additive.** It ran _instead of_ the API pass, so no
    single invocation ever covered both — and the module's own cron entry therefore
    silently omitted every browser-only board. `--browser` now appends the Chrome
    pass to the API pass, `--browser-only` keeps the exclusive behavior, and the
    cron entry is `jobs scrape --all --browser`. The Chrome pass probes for a
    reachable browser first and skips with a clear message when there is none, so a
    host without Chrome loses the browser boards rather than the whole scrape.

### Patch Changes

- Updated dependencies [9e4668b]
- Updated dependencies [e08752c]
  - @schlessera/brain@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain@0.2.0
