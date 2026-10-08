---
"@schlessera/brain-ui-react": minor
---

A service-worker update no longer reloads the page during a voice dictation or
while dictated text waits in the review card, even when the composer's text
field is empty. The reload waits for every update hold registered on the root
and fires once when they are all idle. `registerUpdateHold(root, { busy,
subscribe })` lets other local work hold the reload the same way; the shell's
`isBusy` option still adds its own work.
