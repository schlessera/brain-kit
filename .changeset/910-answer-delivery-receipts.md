---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
---

Interactive answers are delivered with receipts (breaking for ask answers,
#910). A host now settles an `ask_user`, `ask_user_list`, `ask_user_rank` or
`ask_user_form` answer only when it carries a `submissionId`, and tells the
sender what happened with an `ask_answer_receipt`. **Compatibility break:**
an older client's answer, which carries no `submissionId`, is refused with an
`ASK_ANSWER_UPDATE_REQUIRED` error and the question stays waiting. An updated
client shows "Update needed" instead of answering a host that does not
advertise `askReceipts`. Update the client and the host together. Tool
approvals, dismissals, location and mask replies are unchanged.

The wire protocol is revision 5. It adds `ask_answer_status`, `ping`/`pong`
liveness probes, `server_hello.principalKey`, and the `askReceipts` and
`liveness` capabilities. After `session_resume` the host re-sends that
session's pending questions. On the Claude backend an ask's request id is
now the model's `tool_use` id, so a card rebuilt from history answers the
same request as the live one.

`BrainUiClient` probes a foreground socket after 15 seconds without traffic
and replaces it if no `pong` arrives within 5 seconds. It also abandons a
connection attempt that has delivered nothing after 10 seconds, and exposes
`checkLiveness()`, `setForeground()`, `supportsAskReceipts` and `hello`.

In the chat UI, a request delivered twice, or after history, is one card.
A submitted answer is saved on the device (IndexedDB), then sent. It shows
as answered only on the host's receipt, and it is retried automatically after
a reconnect or a reload. The queue holds up to 16 answers and 16 MiB for up
to 24 hours. It is coordinated across tabs, and it is cleared at sign-out.
Each card shows where its answer stands, with Cancel sending, Copy answer,
Send as message, Edit and Try again where they apply. After Submit, focus
moves to that status rather than to the composer.
