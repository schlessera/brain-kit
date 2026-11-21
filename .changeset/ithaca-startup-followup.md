---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
---

Bound backend startup steps and MCP diagnostics per lifecycle, with an explicit omitted observation count. Preserve the existing Activity snapshot wire behavior and repair clipped lifecycles with deltas sent only to the subscribing socket. Keep index floors at changes already passed by the pump, while allowing pending child and event deltas to arrive. Read lifecycle records and sequence floors consistently, with sequence-before-row reads for older stores.

Use one epoch-anchored monotonic lifecycle clock and close recovered lifecycles at their last persisted observation. Require completed governed and journal evidence inside each phase's milestones in native qualification.
