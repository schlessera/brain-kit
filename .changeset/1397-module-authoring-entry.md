---
"@schlessera/brain": minor
"@schlessera/brain-module-finance": minor
"@schlessera/brain-module-images": minor
"@schlessera/brain-module-jobs": minor
"@schlessera/brain-module-speaking": minor
"@schlessera/brain-module-travel": minor
"@schlessera/brain-module-video": minor
---

Add `@schlessera/brain/module`, the supported entry for module authors (`@experimental` until 1.0). It carries the path-containment and atomic-write helpers (`safeResolve`, `resolveWritable`, `writeFileSafely`, `WriteRefusedError`), the scratch helpers, frontmatter splitting and generated regions, `buildTaxonomy`, `getMarkdownFiles`, `runRegistry`, and completion-provider resolution (`resolveCompletionProvider`, `geminiCompletions`, `GEMINI_FLASH_MODEL`). `CommandContext` gains an optional `completions`, the brain's `completions` config block, so a module command honours the configured provider. The first-party modules now use this entry instead of `@schlessera/brain/internal`, so a module published outside this repository can do everything they do. `GEMINI_FLASH_MODEL` is now typed `string` rather than its literal value.
