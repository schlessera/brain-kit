---
"@schlessera/brain": minor
---

The MCP server now sends `instructions` at `initialize`. They say the brain is the source of truth for facts about its owner, named from `profile.name` when the config sets one (as quoted data, flattened to one line and capped at 80 characters). They also say which tool to use for searching, briefing, reading and following links, and to write through `brain_add` and `brain_update`. Tool descriptions now state their limits: `brain_search` returns at most 50 results, `brain_list` at most 100, and `brain_graph` goes at most 5 hops. `brain_context` says how it fits its budget, and `brain_add` says classification is rule-based, with no model call.
