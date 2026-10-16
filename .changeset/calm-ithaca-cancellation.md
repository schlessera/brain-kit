---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-pi": patch
---

Exclude shell calls ended by the user's Stop from governance roadblocks on both backends, while retaining genuine nonzero exits and failures completed before cancellation. Pi reports an aborted shell execution as an abort error instead of an ordinary nonzero result.
