---
"@schlessera/brain-backend-claude": minor
---

The Claude backend's bridge tools — `show_block`, `ask_user`,
`get_current_location`, `request_image_mask` and `query_activity` — are now in
the model's context on every turn instead of behind a tool search it had to
decide to run. The Agent SDK defers an MCP server's tools by default, so until
now a bridge tool was only reachable once the model went looking for it, and
the one thing that sent it looking was a line of prompt text naming the tool.
Measured over 108 live turns, `show_block` fired on 56% of turns that way
against 78% with the tools loaded, and on none at all when that prompt line was
removed. Turns cost about 6% more and start no slower.
