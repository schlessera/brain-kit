---
"@schlessera/brain-ui-react": minor
---

In-chat tool results render from their contract, on every backend.

`bind(contract, Component)` types a component as the contract's payload and
parses the tool's `output` through the same schema before rendering it. Drift
is a `tsc` error — binding a component the payload does not fit, or reading a
field the tool stopped sending, both fail the typecheck — and a result that
does not parse falls back to its raw output rather than blanking the row, which
is what a denial, a timeout or an older server actually produces.

The first binding is `get_current_location`, which also closes a real gap: it
had a renderer only under Claude's `mcp__brain-ui__` name, so the identical
tool on the pi backend rendered as raw JSON and a resumed transcript carrying
the pre-rename prefix did too. A bound contract registers every spelling of its
name, globally, because the tool is the chat UI's own rather than any one
backend's.

`isLocationTool` is gone with it — it was never called, and it could only ever
recognise one of the three names.
