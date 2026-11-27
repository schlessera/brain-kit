---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-backend-claude": patch
---

`@schlessera/brain-ui-sdk/server` exports the experimental backend toolkit helper `admitToolDispatch` and its input type `ToolDispatchAdmission` (#4767): the host's final admission of one tool call (wait for pending safety recordings, validate, take a dispatch ticket or call `allowed`, wait, validate again, commit, then expose the allowance with no await after the commit). Both backends call it at every final admission instead of five hand-written copies. The Pi in-process permission gate and the Claude `canUseTool` callback now also wait for pending safety recordings before their first validation, as the other three sites already did.
