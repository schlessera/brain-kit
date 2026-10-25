---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Changed: the hosted server commits every turn-budget ledger write (admission, session binding, completed-response and relayed-provider usage, warnings and the SDK backstop) on its SQLite write worker at `synchronous=FULL`, in submission order, instead of on the event loop (#2850). A relayed provider request is admitted only once every earlier budget write has committed.
Changed: the provider relay awaits a promise returned from its `admit` hook.
