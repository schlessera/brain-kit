---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Retry unconfirmed failed-launch cleanup and release its reserved capacity only after worker and native-resource cleanup is confirmed.

Report stranded cleanup charges consistently when a legacy launch error provides no retryable close, without scheduling futile retries.
