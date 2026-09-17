---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Remove automatic RTK command rewriting from both backends and remove the SDK's
RTK-specific exports. Agent-side shell wrappers belong to the agent's tooling;
backends execute commands admitted by the existing permission and locking gates.
