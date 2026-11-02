---
"@schlessera/brain-backend-claude": patch
---

Governed and strict Claude turns on the turn egress proxy are no longer tainted by the Claude runtime's own traffic. The runtime's first-party event logging, feature-flag fetches and WebFetch's domain check went to `api.anthropic.com` as ordinary worker connections, so every session was tainted before its first tool ran. WebFetch and the brain CLI's relayed providers, such as reranking, were then refused any new host. A relayed turn now pins `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and skips WebFetch's domain check, so the runtime sends only relayed inference, and the host's egress policy is the only check on a fetch. What taints a session is unchanged: a tool's own connection, including one to the vendor's host, still taints it. Title usage is still observed unless the operator opts out of telemetry themselves.
