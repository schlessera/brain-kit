---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Pi gets host-owned web tools. Ordinary governed and strict interactive sessions list `web_search`, `fetch_content`, `get_search_content` and `source_check`. Each call is forwarded over the worker's bridge to the host, which binds it to the turn's principal, session, profile and policy revision. The host runs the call in its own web executor and keeps provider configuration and credentials out of the worker. Parameters follow the pinned pi-web-access tools, narrowed: no endpoint, proxy, command, local-path or credential field, and providers are limited to the curated catalog and the subset the host admits. Answer mode, summaries, curator review, video analysis and browser-cookie or credential-command modes answer an explicit `unsupported` result. A `responseId` is a host handle scoped to the calling session. Calls are bounded in bytes, fan-out, concurrency, queue and deadline, and are cancelled and drained with the turn or the executor. Every result passes the input-safety collector before the model sees it. Autonomous turns get none of the tools. Until a host configures an executor (the production executor is a follow-up), the tools are listed and refused before they run.

The SDK adds the four tool contracts, `WebToolEnvelope`, `parseWebToolInput`, `handleWebTool` and the optional `BackendBridge.webAccess`. `get_search_content` and `source_check` results now taint a session as `web_fetch` and `web_search`.
