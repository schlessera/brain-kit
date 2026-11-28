---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Stabilize tainted-destination network approval cards, add scoped network approvals (`once`, `origin`, `session`), report truthful approval expiry attribution, and ship dedicated network approval UI components (#4966, #1763, #3595, #4967):

- **Protocol & SDK (`@schlessera/brain-ui-sdk`)**:
  - Add optional `approvalUpdates`, `networkApprovalScopes`, and `networkGrants` capability flags in `client_hello` / `server_hello`.
  - Add optional `revision`, `origin`, and `network` (`NetworkApprovalOffer`: `transport`, `scheme`, `host`, `port`, `scopes`, `managedReference`, `suspendedGrant`, `classes`) on `tool_approval_request`; optional `revision` and `networkScope` on `tool_approval` / `tool_denial`; optional `expiryCause`, `networkScope`, and `grantedByGrant` on `tool_resolution`; and the `network_grants` server frame (`NetworkApprovalScope`, `NetworkApprovalOffer`, `NetworkGrantView`, `SessionNetworkGrantsResponse`, `ServerNetworkGrants`, `ToolResolutionExpiryCause`).
  - Export `NetworkCardController` on `@schlessera/brain-ui-sdk/server`.
- **Host & HTTP (`@schlessera/brain-ui-server`)**:
  - Keep `toolName: "Network"` taint cards open across further occurrences of already-shown classes and healthy `recordingPending` writes, update in place with a new `revision` and arming window on new taint classes, reject stale/arming replies, and withdraw orphaned connections with `operation_cancelled`.
  - Distinguish `timeout` and `cancelled` (`host_stopped`, `safety_changed`, `turn_ended`, `operation_cancelled`, `grant_storage_failed`, `cancelled`) from explicit user `denied` on `tool_resolution`, Activity spans, and roadblocks.
  - Enforce `once` (single connection, excluded from `contactedHosts`), `origin`, and `session` grants (suspended on new taint class, never bypassing `network.deny`, voice restrictions, or managed GitHub acquisition `once`-only isolation).
  - Mount `GET /api/sessions/:id/network-grants` and `DELETE /api/sessions/:id/network-grants/:grantId`, and record `network_grant` and `network_grant_revoked` governance events (plus optional `egress_connection.approvalScope`).
- **UI Kit & React (`@schlessera/brain-ui-kit`, `@schlessera/brain-ui-react`)**:
  - Add presentational `NetworkApprovalCard` and `ApprovalStack` components and Storybook stories in `@schlessera/brain-ui-kit`.
  - Wire in-place revision updates, arming-window protection, sending-before-resolution state, origin grouping, standing grant revocation bar, and truthful expiry receipts in `@schlessera/brain-ui-react`.
