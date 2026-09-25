---
"@schlessera/brain": patch
---

`/brain-init` no longer registers the MCP server a second time. Its validation ladder now reads the `mcp` check of `brain doctor --json` first, and runs `claude mcp add` only when that check does not pass. A brain made from the template already declares the server in its `.mcp.json`, so the interview leaves it alone and goes straight to checking that the `brain_*` tools answer. That check now reads `me/identity.md` through the tools and compares it with the file on disk, and when the server that answers serves another brain or does not start, the interview registers one for this project.
