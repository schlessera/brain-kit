---
"@schlessera/brain-ui-server": minor
---

An autonomous turn whose provider rules mask a folder now starts only when the server can show that every item and checkpoint of its origin inbox thread was written without those folders (#2741): a person's arrival through the share or queue route, server-composed text, or an autonomous run that already masked them. Otherwise it refuses with `provider_masked` before its prompt is built or any provider is reached, and its `inbox_list` and `inbox_get` revalidate the same evidence and refuse after an incompatible change or a policy change. Work queued before a provider rule, or added by a conversation, is refused rather than assumed safe; it stays stored and queued. Tool names and schemas are unchanged, and turns without masked folders are unaffected.
