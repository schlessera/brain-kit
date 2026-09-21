---
"@schlessera/brain-ui-react": minor
---

Classified blocks render in place (D42). `MarkdownContent` takes the
`message_blocks` a host sends after a turn, cuts the text part at each
block's span, and draws the kit block between the markdown pieces through
the same `BlockCard` that renders `show_block`. History carries the blocks
on replay. A message without blocks renders exactly as before; a span that
does not fit the text is ignored rather than rendered blank.
