---
"@schlessera/brain-ui-server": patch
---

Accept a browser `Origin` when a trusted proxy forwards `ws`/`wss` as the
upgrade scheme. Several reverse proxies report the connection scheme in
`X-Forwarded-Proto` on a WebSocket upgrade, so the expected origin was built as
`wss://host` — which no browser Origin can match. Every handshake that fell
back to the Origin comparison (browsers that omit `Sec-Fetch-Site` on the
handshake, including Safari and installed PWAs) was refused with
`Cross-origin WebSocket rejected` while ordinary HTTP requests kept working.
`wss` now compares as `https` and `ws` as `http`; a plaintext upgrade still
cannot match an https Origin.
