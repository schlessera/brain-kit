---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

pi backend parity with the Claude backend.

- **Approvals**: mutations no longer each raise a card. A single `tool_call`
  permission gate (inline extension, fires before every tool — curated and
  extension-registered) implements the Claude posture: allowlisted tools run
  free, destructive bash shapes confirm (shared
  `DEFAULT_CONFIRM_BASH_PATTERNS`, moved to `brain-ui-sdk/server`),
  non-allowlisted tools ask. `brain_archive` keeps its card.
- **Context**: both `AGENTS.md` AND `CLAUDE.md` load when the brain repo has
  both (pi previously took AGENTS.md alone — the Claude backend reads
  CLAUDE.md, so the two backends saw different instructions). The
  system-prompt append is now built per session from the opening turn's
  client environment and turn budget, like the Claude backend's per-turn
  brief.
- **Tools**: curated surface extended to the full brain MCP set
  (`brain_read`, `brain_list`, `brain_graph`, `brain_update`,
  `brain_archive`) plus bridge-backed `get_current_location` (reverse
  geocoding shared via `brain-ui-sdk/server`), `query_activity`, and
  `request_image_mask`, each registered per host capability.
- **Extensions**: `loadExtensions` now defaults to true — the gate covers
  extension tools. Recommended: `pi-web-access` (web search/fetch,
  auto-allowed like Claude's WebSearch/WebFetch) and `pi-mcp-adapter` (MCP
  servers from `.mcp.json`, prompted like non-allowlisted MCP tools).
- **rtk**: when the `rtk` binary is on PATH, both backends route bash
  commands through rtk's rewrite oracle (`git status` → `rtk git status`,
  60-90% less output for the model to read). Applied after gating, so
  confirm patterns see the original command; absent rtk changes nothing.
- **Upstream bump**: pi SDK 0.80.10 → 0.84.4 (`pi-coding-agent`,
  `pi-agent-core`, `pi-ai`). Verified: event mapping already delta-based
  (0.84's `message_update` change), auth already on the `ModelRuntime` API,
  extension install + load re-tested on 0.84.4.
- **Web search settings**: new Settings → Models → "Web search" card (pi
  deployments only). Provider select defaults to Auto — Exa's free keyless
  tier — with per-provider API keys (Exa, OpenAI, Brave, Tavily, Perplexity,
  Firecrawl, Jina, Kagi, Gemini) stored server-side in the pi config dir's
  `web-search.json`, the file pi-web-access reads. Key values never travel to
  the client; hand-edited config fields beside the managed ones survive; a
  save clears pi's extension cache so new conversations pick the change up.
