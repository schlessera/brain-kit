---
"@schlessera/brain-ui-sdk": minor
---

`show_block`: the kit's answer blocks reach the model through one tool (D41).

A new tool component contract, `SHOW_BLOCK_CONTRACT`, whose argument is a
discriminated union of eleven data-only blocks — `comparison`, `stats`,
`trend`, `table`, `bars`, `receipt`, `steps`, `timeline`, `schedule`, `quote`
and `contact` — each mirroring the props of the kit component that draws it.
The tool has no side effect: `handleShowBlock` validates and echoes, so the
payload is the input and it needs no bridge. It joins `BRIDGE_TOOL_CONTRACTS`
and the auto-allow posture, `SurfaceTools` gains `block`, and the generated
prompt paragraph carries a brief that says when a block beats prose while the
description carries the shape rules. The schema's tone lists are exported as
runtime constants so a consumer can assert them against the kit's unions.

The brief leads with the one rule the model most often breaks — never a
markdown table, call the tool — and the description opens with the same
redirect, because a table the model would have typed is a `comparison` or
a `table` block that was not drawn.
