---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": patch
---

Backends can remove one explicitly retired chat's local native history (#3229). `BackendCapabilities.historyRemoval` and the optional `AgentBackend.removeSessionHistory()` are new; the Claude and Pi backends implement them. A removal first fences the session permanently, so it is no longer listed, read, resumed, archived or restored, even after a restart. It then waits for the session's running turns and readers, and removes the live, archived, staged and conflict copies, subordinate and branch files, display and prompt metadata and file observations. Links, hard links, redirected storage and replaced files are left untouched and reported as `partial`, never as removed. Nothing exposes deletion to users yet: the endpoint and interface are separate work, and provider-held copies and backups are outside local removal.
