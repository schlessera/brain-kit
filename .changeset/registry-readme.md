---
"@schlessera/brain-ui-server": patch
---

Document the descriptor-driven backend registry in the README: `AGENT_BACKEND`
selects among first-party ids only, a third-party backend is passed by value to
`createApp({ registry })`, and a session pinned to an unknown backend id now
fails explicitly.
