---
"@schlessera/brain-ui-server": minor
---

A hosted interactive or voice turn whose provider rules mask a folder can no longer read the activity record or the inbox (#2698). `query_activity` in every scope, `inbox_list` and `inbox_get` refuse with the named `provider_masked` refusal before reading anything, because those records keep text from earlier runs that may quote a masked document. The tools stay registered; turns without masked folders, and the app itself, read them as before.
