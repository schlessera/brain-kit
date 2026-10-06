---
"@schlessera/brain-ui-react": minor
---

A restored approval card now follows the host. When the host advertises session recovery, a card it re-delivered after a reload stays answerable only while the recovery envelope lists its request as pending. Otherwise it turns read-only, without Allow or Deny, and says why: `answered on another device`, `ended with the turn` or `no longer yours to answer` (after a 401/403 read or a revocation, which also drops the card's request and turn identities). Nothing is sent when a card closes. The read is the tracker client's existing recovery read, now also made for a session that holds a restored card. A turn shell's header shows the host's `startedAt` for its turn when the envelope's latest turn is that one, and no time otherwise, instead of the page's clock. Without the capability, cards behave as before. `ToolCall` gains `approvalTurnId` and `readOnly` (a `RestoredApprovalClosure`), and `ChatMessage` gains `turnShell`.
