---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
---

On hosts with managed native storage, run governed and strict Claude turns on their own turn egress proxy and the host inference relay by default. Every connection becomes a governance event, policy limits apply, and a connection to an outward host waits for approval unless the tool call in progress was classified as a read or an approved outward action to that host. The capabilities note states recorded egress only for a worker actually routed through the proxy, together with the remaining reachable-socket gap. Elsewhere those turns keep their current network, and `runtime.workerHost.governed.egress` on `GET /api/status` says which applies.

The relay forwards to the server-selected route (a profile's `baseUrl`, else `ANTHROPIC_BASE_URL`). A custom origin may receive the host's Claude login only when `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` lists it exactly. **Migration:** if a subscription profile or `ANTHROPIC_BASE_URL` points Claude at a custom origin on a host with managed native storage, add that origin to `BRAIN_UI_CLAUDE_OAUTH_ORIGINS`, or those turns are refused before their prompt is sent.

A model-discovery cache entry in the brain no longer supplies a profile's `baseUrl`, credential variable names, model aliases or tools; only the fields discovery itself writes are read back.
