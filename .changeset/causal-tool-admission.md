---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Add a host-owned causal admission view for exact tool calls. Recheck independent evidence and trust revisions after the last approval, collection and lock waits while excluding only the exact call's own recorded input and its pending reservations. Add optional single-use host-owned prepareDispatch tickets so asynchronous preparation cannot record a dispatch that the final check refuses; legacy hosts retain conservative gaps.
