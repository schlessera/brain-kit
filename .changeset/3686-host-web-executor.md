---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Pi's web tools now run on the host. Wherever the pi backend is configured, the server starts a trusted web executor for each conversation that uses them: the pinned upstream `pi-web-access` 0.41.0 extension in a real Pi SDK session, now a dependency of the pi backend. That process loads only that extension, with empty settings, in a fresh private directory beside the UI database. It reads a sanitized copy of the host's `web-search.json` and gets the catalog providers' API keys from the host environment. Nothing reaches the worker. The copy turns off the extension's workflow, curator, summary, media, GitHub-cloning, command and browser-cookie paths, and removes every `!command` credential, which the host never runs. The directory is removed when the executor ends, and one that dies is replaced on the next call.

`GET /api/web-search` reports what the web tools do not offer, as `unavailable`, and marks a provider whose stored key is a credential command with `keyIsCommand`. Such a key no longer counts as a credential, so it cannot enable a provider. The Settings card lists the unavailable features, and the Pi system prompt names them for sessions that list the web tools. Pi no longer reads `web-search.json` inside the worker for its brief. `buildSystemPromptAppend` accepts `webTools: true`.
