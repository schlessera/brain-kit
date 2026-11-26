---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

A tainted Network approval card now offers four choices (#3595): **Allow once**, **Allow this origin for this session**, **Allow all origins for this session** and **Deny**.

- **Wire (ui-sdk).** `ServerToolApprovalRequest.network` (`NetworkApprovalOffer`: `transport` `http` or `connect`, `host`, effective `port` and the offered `scopes`) advertises the destination's origin. `ClientToolApproval.networkScope` (`NetworkApprovalScope`: `once`, `origin` or `session`) answers it, and `ServerToolResolution.networkScope` reports the granted scope. `PermissionRequest.network` and the allow `PermissionDecision.networkScope` carry them to and from backends. Every field is optional: a reply without a scope keeps the earlier host-wide session answer, and a scope the card did not offer narrows to once.
- **Host (ui-server).** Once allows one connection and asks again, also for a concurrent connection to the same destination and in later turns. An origin grant covers the same transport, host and port, so HTTP and an opaque CONNECT tunnel stay distinct. A session grant covers every destination. Both commit a new `network_grant` governance event for the chat session before the connection is admitted, grant nothing when that write fails or the turn has stopped, and hold across later turns and reconnects of the same session only. A connection admitted under a scope records it as `networkScope` on its `egress_connection` and never becomes a contacted host. Deny and allow lists, byte limits, outward approvals, voice and autonomous turns are unchanged. The `approval_decision` activity event records the scope.
- **Cards (ui-react, ui-kit).** The transcript card and the Actions card show the four labels; Allow, and the `a` key, are the narrowest choice. Receipts name the granted scope. The kit `ApprovalCard` gains `widerAllows` for the extra full-width choices.
