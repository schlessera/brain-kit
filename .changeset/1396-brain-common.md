---
"@schlessera/brain-common": minor
"@schlessera/brain": patch
"@schlessera/brain-scrape": patch
"@schlessera/brain-module-finance": patch
"@schlessera/brain-module-images": patch
"@schlessera/brain-module-jobs": patch
"@schlessera/brain-module-travel": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Add `@schlessera/brain-common`, an internal-only package with no compatibility promise. Its `./internal/env` entry holds the environment descriptor core and `./internal/frontmatter` holds the cache-free `parseFrontmatter`. The packages that carried byte-identical copies of these files now depend on it instead. Environment and frontmatter parsing behave exactly as before, and every public export is unchanged. module-finance, module-jobs, module-travel and ui-server no longer depend on `gray-matter` directly.
