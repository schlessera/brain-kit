# @schlessera/brain-module-video

## 0.43.0

### Patch Changes

- @schlessera/brain@0.43.0

## 0.42.1

### Patch Changes

- @schlessera/brain@0.42.1

## 0.42.0

### Patch Changes

- Updated dependencies [3b408f8]
- Updated dependencies [5876df6]
- Updated dependencies [185803c]
- Updated dependencies [999dbe6]
- Updated dependencies [46056f6]
- Updated dependencies [703a922]
- Updated dependencies [1283ca4]
- Updated dependencies [7a10cdf]
- Updated dependencies [b8862b3]
- Updated dependencies [4914236]
  - @schlessera/brain@0.42.0

## 0.41.0

### Minor Changes

- a4120ed: Add `@schlessera/brain/module`, the supported entry for module authors (`@experimental` until 1.0). It carries the path-containment and atomic-write helpers (`safeResolve`, `resolveWritable`, `writeFileSafely`, `WriteRefusedError`), the scratch helpers, frontmatter splitting and generated regions, `buildTaxonomy`, `getMarkdownFiles`, `runRegistry`, and completion-provider resolution (`resolveCompletionProvider`, `geminiCompletions`, `GEMINI_FLASH_MODEL`). `CommandContext` gains an optional `completions`, the brain's `completions` config block, so a module command honours the configured provider. The first-party modules now use this entry instead of `@schlessera/brain/internal`, so a module published outside this repository can do everything they do. `GEMINI_FLASH_MODEL` is now typed `string` rather than its literal value.
- d641a7d: Add an opt-in Gemini video module with timestamped watch answers, clip windows,
  privacy disclosure and bounded upload/use/delete cleanup. Extend completion
  parts with video, optional video capability and request cancellation; existing
  custom providers without video capability remain valid and refuse video.

  Raise the optional Gemini SDK minimum to 2.24.0 so every supported installation
  has the client-level fetch option needed to cancel binary uploads.

### Patch Changes

- Updated dependencies [8e5c9e8]
- Updated dependencies [b0815ec]
- Updated dependencies [62cf4d6]
- Updated dependencies [a8f884f]
- Updated dependencies [6cb61cb]
- Updated dependencies [20557bf]
- Updated dependencies [b81ff20]
- Updated dependencies [1caadca]
- Updated dependencies [a4120ed]
- Updated dependencies [08663e0]
- Updated dependencies [825cd04]
- Updated dependencies [e12287d]
- Updated dependencies [2edf82b]
- Updated dependencies [2907722]
- Updated dependencies [1a943d8]
- Updated dependencies [1de5e19]
- Updated dependencies [651718a]
- Updated dependencies [d57dc62]
- Updated dependencies [e632b50]
- Updated dependencies [dbea4f5]
- Updated dependencies [ae61e82]
- Updated dependencies [d4eff9f]
- Updated dependencies [a95a924]
- Updated dependencies [8cb13a6]
- Updated dependencies [a26209c]
- Updated dependencies [7719bca]
- Updated dependencies [2a7de32]
- Updated dependencies [83585eb]
- Updated dependencies [9072d22]
- Updated dependencies [b300bb3]
- Updated dependencies [d641a7d]
  - @schlessera/brain@0.41.0
