---
"@schlessera/brain-common": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain": minor
---

Send Gmail drafts only after approval of their complete plain-text contents, using the exact reviewed raw bytes and durable digest replay protection. Add card-only draft deletion and trash, report incomplete draft cleanup after a confirmed send, and explicitly refuse irreversible operations in standalone commands. Only a send that failed before any request reached Google (gog could not start, or its credentials are missing) lets a freshly approved card send the same bytes; every other failure, Google refusals and gog exit 2 included, keeps them blocked and says the send may have gone out. Report unknown draft cleanup as null.
