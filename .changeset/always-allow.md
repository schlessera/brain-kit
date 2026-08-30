---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

"Always allow" per tool.

- Approval cards gain an **Always allow** button: the host remembers the
  tool (server `settings` table) and answers its future requests without a
  card — for both backends and any extension/MCP tool, since the grant is
  applied host-side in the ws bridge before a card is ever emitted.
- Permission requests now carry a `kind`: `"tool"` (grantable) vs
  `"command"` (a destructive-bash confirm-pattern confirmation). Kind
  "command" can neither be remembered nor auto-answered — the client hides
  the button and the host refuses a tampered `always` flag — so the
  destructive-command seatbelt stays per-use.
- Settings → Models gains an **Always-allowed tools** list with per-tool
  revoke (`GET/DELETE /api/tool-permissions`).
- Wire protocol: additive `always?: boolean` on `tool_approval`, additive
  `kind?` on `tool_approval_request` (re-delivered cards included).
