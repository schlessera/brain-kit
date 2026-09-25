---
"@schlessera/brain": minor
---

`brain doctor` has a new `instructions-weight` check. It estimates the tokens every session loads before any work starts, as characters ÷ 4 (the same estimate `brain context` uses). That total covers `CLAUDE.md` with its in-brain `@` imports resolved one level, `AGENTS.md`, and the description of every skill without `disable-model-invocation: true`. The check reports every counted file and skill with its estimate. Only files whose real path is inside the brain count, and an import that cannot be read makes the check warn, because the total is then incomplete. Above the new optional `brain.config` key `instructions.maxTokens` (default 8000), it warns and names the three largest contributors. A brain fresh from the template measures about 2,000 tokens.
