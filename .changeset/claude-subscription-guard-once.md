---
"@schlessera/brain-common": patch
"@schlessera/brain": patch
"@schlessera/brain-backend-claude": patch
---

The Claude subscription billing guard now has one implementation, in the new internal entry `@schlessera/brain-common/internal/claude-subscription` (#2493). It holds the cleared credential variables, the neutralised flag settings, the settings refusal and the account check. core's Claude CLI runner and the chat backend both import it instead of carrying their own copies, so a credential or routing variable found later is added once and protects both. Which variables are cleared, which settings are refused and how subscription login works are unchanged. The entry is internal and carries no compatibility promise.
