---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-pi": patch
---

The server now records every roadblock an agent hits in a turn (#1671). This covers tool errors, nonzero shell exits, `EROFS` and `EACCES` refusals, permission and policy denials, budget and scope limits, network refusals and repeated attempts. At turn end, the server groups each turn's failed steps into episodes, for Claude and pi alike. Each episode records the call that finally worked, the time, tokens and cost the detour wasted, and whether better guidance or a new capability would remove it. Episodes are stored as `roadblock` governance events in the session's kept history and read through `GET /api/governance/events`. Nothing is shown to the user. Token and cost waste stay unknown, never zero, for interactive turns until those turns report usage as they run. The pi `bash` tool now ends a long, clipped failing output with its `[exit N]` line too.
