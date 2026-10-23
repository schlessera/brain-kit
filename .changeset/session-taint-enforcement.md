---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A session that ingests untrusted content now runs under tighter rules for the rest of the session. WebFetch/WebSearch and pi web results, reads under `.brain-ui/inbox/` or `workspaces/`, results from any MCP server other than brain-kit's own, and fetching or unclassified Bash calls record the session's first `taint` governance event. While tainted, every outward action asks for approval even when `outward.allow` matches, and its `outward_action` event says `tainted: true`. On the turn egress proxy, any connection other than the inference relay also taints the session, and a tainted session's new connections reach only `taint.egress.allow` and hosts the session already contacted; refusals are `egress_denial` events with reason `taint_allowlist`. Turns without the proxy keep their network, and the capabilities note says tainted egress is not enforced there.
