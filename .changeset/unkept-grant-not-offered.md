---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

An approval card no longer offers "Always allow" for a grant the host will not
keep. `tool_approval_request` gains an optional `rememberable: false`, sent for
a request outside the turn's enforced allowlist and again when the card is
re-delivered on reconnect; both approval surfaces hide the button for it, and
the Actions receipt no longer prints "Always allowed" for a decision that was
not remembered.
