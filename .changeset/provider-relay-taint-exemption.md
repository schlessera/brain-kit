---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---
**Breaking (taint policy, #3246):** a validated request through the brain CLI's provider relay no longer taints a governed session, and taint no longer narrows it. Reranking and WebFetch now work in either order, instead of whichever came first refusing the other with `taint_allowlist`. Every other control still applies to these requests: the egress deny and allowlist rules, exact origin, recipient and route authorization, byte ceilings, budgets, cancellation and accounting. Worker HTTP and `CONNECT` traffic cannot claim the exemption, even to a provider's host.

Migration: after untrusted input, taint alone no longer keeps content from a session's approved providers. Use `egress.deny`, `allowlist` mode or `BRAIN_UI_CLI_PROVIDER_ORIGINS` to fence a provider. No event, configuration or wire shape changes.
