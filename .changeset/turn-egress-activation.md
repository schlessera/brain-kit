---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
---

Run governed and strict Claude turns on their own turn egress proxy and the host inference relay by default. Every connection becomes a governance event, policy limits apply, and a connection to an outward host waits for approval unless the tool call in progress was classified as a read or an approved outward action to that host. The capabilities note states recorded egress only for a worker actually routed through the proxy, together with the remaining reachable-socket gap.
