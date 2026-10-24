---
"@schlessera/brain-ui-server": minor
---

An item a hosted conversation adds through `inbox_add` can now qualify a provider-masked autonomous turn (#2816). It qualifies when the conversation was born masking provider folders and kept every folder the autonomous turn masks hidden from each of its turns, up to and including the one that added the item. The server records this from its own lineage record for that turn, never from anything the model sends. Items from conversations that started before a provider rule, were shown a masked folder by a later turn, or have lost their record are still refused with `provider_masked`. Tool names, schemas and results are unchanged.
