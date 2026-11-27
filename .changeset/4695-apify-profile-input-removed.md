---
"@schlessera/brain-common": patch
---

Removes `profileInput`, `ApifyProfiledInput` and `ApifyProfileInputError` from the internal `@schlessera/brain-common/internal/apify` entry, with the private schema walker behind them (#4695). Nothing has called them since the Actor-approval ruling replaced per-run input restrictions (#3582), so they read as a guard on every Apify run while guarding none. The internal entry carries no compatibility promise; the Apify CLI and MCP surface is unchanged.
