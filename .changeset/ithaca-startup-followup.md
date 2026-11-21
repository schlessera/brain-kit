---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
---

Bound backend startup steps and MCP diagnostics per lifecycle, with an explicit omitted observation count. Preserve the existing Activity snapshot wire behavior while lowering sequence floors for omitted records and replaying their existing deltas. Read lifecycle records and sequence floors consistently, and keep index floors below omitted child and event subscriptions.

Use one epoch-anchored monotonic lifecycle clock and close recovered lifecycles at their last persisted observation. Require completed governed and journal evidence inside each phase's milestones in native qualification.
