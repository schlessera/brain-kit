---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Changed: the hosted server commits governance events raised outside a journal transaction, the session's first taint, roadblock records and turn scope rows on its SQLite write worker at `synchronous=FULL`, in submission order with journal and Activity writes, instead of on the event loop (#2850). A turn's egress connection sends its first byte only after its taint has committed, and admission counts that taint from the moment it is submitted.
Changed: the egress proxy awaits a promise returned from its `admitted` hook before the connection's first upstream byte.
