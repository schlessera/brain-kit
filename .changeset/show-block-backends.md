---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Both backends register `show_block` and auto-allow it. It needs nothing from
the host bridge, so it is always present: the Claude backend's `brain-ui` MCP
server now exists on every turn (as `mcp__brain-ui__show_block`), and pi's
bridge tool list carries it unconditionally, classed `read` in the risk table
because it touches nothing. The system-prompt brief names it on both.
