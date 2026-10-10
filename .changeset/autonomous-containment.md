---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Run autonomous Claude and pi turns inside a restricted envelope. The worker gets a private network namespace with only loopback and an explicit read envelope instead of the host root, so it cannot read the host home, stored logins or the server's environment, and cannot reach the network, DNS or host Unix sockets. Inference leaves only through a server-owned relay socket that forwards the provider's inference routes to the profile's upstream and injects the server-held credential; the worker holds a placeholder. Restricted turns load no project settings, instructions, skills, hooks, MCP servers or pi extensions, and use only the server's instruction snapshot and enforced tool roster.

Additive SDK surface: `AutonomousTurnOptions.containment: "restricted"`, `BackendCapabilities.restrictedAutonomous`, and an optional `supportsRestricted` argument to `assertTurnPosture`. `runAutonomousTurn` always requests containment and refuses a backend without the capability. A restricted turn refuses before any worker starts when the host cannot establish the envelope, when a Claude subscription profile has no `CLAUDE_CODE_OAUTH_TOKEN` (a stored login is never copied into the envelope), or when a pi profile has no API key for an Anthropic Messages or OpenAI-compatible provider. Interactive, voice and handoff-summary turns are unchanged. Nothing dispatches autonomous work in production yet.
