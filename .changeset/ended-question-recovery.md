---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-react": minor
---
A question whose turn ends before it is answered no longer loses what the user had entered, and a turn that hits the host's time limit now says so (#3356). The ended card keeps its draft and says the turn ended or timed out. Its Submit sends nothing to the ended request; it keeps the answer on the card as Not delivered. Send as message is the only way to send it, as one ordinary new chat message carrying the question and the answer, and it is offered once. The host's turn limit is unchanged: it is still a hard elapsed-time limit, and the time a question waits for the user counts against it. When it ends a turn, the cancelled `result` now carries `outcomeDetail: "host_timeout"` (`HOST_TIMEOUT_OUTCOME_DETAIL`) and the `status: cancelled` carries `detail: "Turn timed out"`, and the conversation shows a "Turn timed out" status. The Claude runtime's own stop notices, "No response requested." and "API Error: Request was aborted.", no longer replay as the agent's reply. They arrive as the new `SessionHistoryMessage.runtimeNotice` and are drawn as a short turn status. The same words written by the model or the user stay their text.
