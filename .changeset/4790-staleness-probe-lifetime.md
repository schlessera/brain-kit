---
"@schlessera/brain": patch
---

The MCP server's stale-index probe now uses a bounded share of the server's time on a large brain (#4790). One probe's answer lasts the larger of 10 seconds and 20 times the probe's own duration, so a probe that walks the tree in 2 seconds is repeated at most every 40 seconds instead of every 10. On a brain where the probe takes under half a second nothing changes. `brain_add`, `brain_update` and `brain_archive` reset the cache after their index run, so the next read never serves a warning from before the agent's own write. **Behaviour change:** on a large brain, the warning can appear later after an edit made outside the tools than before. The warning text and tool schemas are unchanged.
