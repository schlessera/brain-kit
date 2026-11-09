---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Sends are durable outgoing snapshots on a host that keeps them (#3155). On a host that advertises `composerFiles` and `sessionDraftLimits.maxOutgoingSnapshots`, Send writes the message as a snapshot in the same save that clears the composer. A message whose files are still uploading is held and sends once, when they are stored. Held, returned and unconfirmed messages appear as bubbles in the transcript, each with its own status and actions: Cancel, Edit, Delete…, Check, Send again, and Send for a hold restored after a reload, which never sends by itself. A chat holding ten of them refuses another Send and sends nothing. Your text stays in the composer, with a notice and a Show button, and Cancel and the other actions keep working. The notice clears once a slot is free. When another tab or device frees it, the client finds out by re-reading that chat's drafts every 15 s while the notice shows and the tab is visible, and at once on focus, reconnect and hello. `BrainUiConnection.drafts` gains `resendSnapshot` and `sendPaused`.

`StatusIndicator` gains an optional `announce` prop. `false` renders no live region, so a consumer that announces the change itself isn't spoken twice.
