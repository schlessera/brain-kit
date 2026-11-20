---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Persist backend startup steps in the optional openSubPhases field through the first inference relay request, keeping host and worker clocks separate and naming missing Claude SDK evidence. Preserve compatibility with older SDKs' closed subPhases enum. Include the steps and explicit fixture coverage in native observation timing receipts.
