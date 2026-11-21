---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Persist backend startup steps in the optional openSubPhases field through the first inference relay request, keeping host and worker clocks separate and naming missing Claude SDK evidence. Preserve compatibility with older SDKs' closed subPhases enum. Include the steps and explicit fixture coverage in native observation timing receipts.

query_activity no longer includes the host lifecycle record, which was never part of its documented result and leaked host timing to the model. The owner-facing Activity API and stream retain the envelope. Bound missing-evidence metadata and isolate timing-observer exceptions from worker execution and cleanup.

Contain asynchronous diagnostic failures and malformed SDK metadata without interrupting observed work. Validate native startup containment while allowing either callback order within the same millisecond.
