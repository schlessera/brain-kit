---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

A turn the host itself stops is no longer reported as "Turn timed out", and the tool it interrupted no longer reads as the user refusing it (#4565). When the host stops a turn because it could not record the turn's safety checks, its changes, an approval's outcome or the chat's inbox shares, the turn's Activity run ends as an error naming that cause, its cancelled result carries `outcomeDetail: "host_stop:<cause>"` and its status says "Stopped by the host". The conversation shows a "Stopped by the host" notice that says why and what to do next, and the interrupted tool shows that the host stopped it. The model still receives the runtime's tool text unchanged. Only the host's time limit records a timeout.
