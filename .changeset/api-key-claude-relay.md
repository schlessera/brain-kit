---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": patch
---

Governed and strict Claude turns on an API-billed profile now run on the turn egress proxy and the host inference relay too, on hosts with managed native storage. The relay sends the profile's `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to the profile's own route; the worker holds only a placeholder, and neither the variable the profile names nor a host `CLAUDE_CODE_OAUTH_TOKEN` reaches it. Billing is unchanged. The `brain` CLI inside such a worker no longer sees that key either, until its own providers are relayed (#1673). Only the credential the profile declares is sent: an ambient `ANTHROPIC_AUTH_TOKEN` no longer rides along to the profile's route. Project or managed settings that move the route, set a credential variable or configure an `apiKeyHelper` refuse the turn before its prompt is sent, as a transport failure. A host Claude login file linked into the brain refuses relayed turns. `runtime.workerHost.governed.egress` no longer lists API-key profiles as unrouted.
