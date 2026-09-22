---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Archiving a document through `brain_update` now raises an approval card.

Archiving is confirmed because it is a visibility change: an archived document
drops out of search, briefings and context assembly, so a silent archive shows
up later as holes in output nobody can account for. Two paths to it stopped for
approval — `brain_archive` is off the default allowlist, `brain archive` matches
a confirm pattern — and a third did not. `brain_update` takes the same `status`
field and is auto-allowed, so `status: "archived"` made a document invisible to
every later search with no card, no confirmation and no record.

`decideToolPermission` now raises a per-use confirmation for a document update
that sets `status: "archived"`, and both backends pass it their spelling of the
tool (`updateToolName`). It is deliberately a per-use confirmation, never a
grantable tool approval: a remembered "always allow" would reopen the hole for
good.

Nothing else changes. An update with no `status`, or with `"active"` or
`"draft"`, runs unprompted exactly as before — this is not a card on every
document edit. `brain_update`'s MCP input schema, output shape and name are
untouched.
