---
"@schlessera/brain-ui-sdk": patch
---

Route Git's SSH transport through the turn proxy in egress workers: the worker bootstrap sets a first-party CONNECT helper as Git's `ProxyCommand` unless the caller chose `GIT_SSH_COMMAND`.
