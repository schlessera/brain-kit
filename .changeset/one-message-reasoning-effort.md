---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Add per-message reasoning effort with saved profile defaults for Claude and Pi.
Claude defaults to Opus 5.5 at medium; each resumed turn re-reads its default,
unsupported levels resolve downward, and retries retain the original override.
Expose supported levels and honest requested/confirmed effort metadata. The
existing model chip opens a model/effort picker; overrides clear on correlated
start or queue acceptance and remain with refused drafts. Older hosts retain
their existing send behavior.
