---
"@schlessera/brain-ui-react": minor
---

Classified blocks render in place (D42). `MarkdownContent` takes the
`message_blocks` a host sends after a turn, cuts the text part at each
block's span, and draws the kit block between the markdown pieces through
the same `BlockCard` that renders `show_block`. History carries the blocks
on replay. A message without blocks renders exactly as before; a span that
does not fit the text is ignored rather than rendered blank.

A `message_blocks` frame is targeted by the turn it belongs to, since a
queued follow-up may have opened a newer assistant message by the time the
pass returns, and it never reopens a finished session's running badge.

The first scoped delta stamps the host's turn id onto the assistant
message the composer opened optimistically, so the turn-targeted frame
finds it; a frame whose turn no message carries lands on the last
finished assistant message, never a streaming one.
