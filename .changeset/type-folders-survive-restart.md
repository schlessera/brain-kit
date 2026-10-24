---
"@schlessera/brain-ui-server": patch
---

A provider-policy turn whose rules select document types is no longer held for 30 seconds and then refused with "An active peer did not retain the requested provider folders" while a cron job, or a writer started after a server restart, is running. The folders a turn translates those types to are now recorded in the UI database under the policy's hash, so writers in every process, and after a restart, plan them while the policy is unchanged. A record from another policy version or another brain, or one that cannot be read, plans nothing. Admission still translates the types itself and still refuses a writer lacking what it masks. The first turn under a new policy version still waits for writers admitted before it, as before.
