---
"@schlessera/brain": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-render-puppeteer": patch
"@schlessera/brain-render-template": patch
"@schlessera/brain-scrape": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain-module-finance": patch
"@schlessera/brain-module-images": patch
"@schlessera/brain-module-jobs": patch
"@schlessera/brain-module-speaking": patch
---

Per-package `test` scripts now pass `--timeout 30000`, so `bun run test` inside a package no longer flakes on bun's 5s default when suites spawn the CLI.
