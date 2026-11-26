---
"@schlessera/brain-ui-react": minor
---

The host Gmail read tools' results now render as the ui-kit Gmail components instead of raw tool output, on every backend and under every spelling of the tool names:

- **Search:** a page of threads as `GmailResultList`, in the view the result carries, under the query the call sent, with "Gmail has more matches" when there is a next page.
- **Read:** a thread as `GmailThread`, a message as `GmailMessage`, each in its view, and the account's labels as `GmailLabels`. A draft keeps the tool's own output until the kit has a draft component.
- **Refusals** are drawn in the host's words.
- **The tool row** shows each call's effect class and view: `read · content view`, `read · structured view`, or `read · no result`.

A message the host cut for the model offers "Show the rest", which loads its full body from the session's display-only detail route only when the reader asks. The rest is shown only when the full body begins with exactly the text Brain read; otherwise it reads as unavailable and nothing is spliced. Route errors read as the kit's states: not found as gone; unavailable, an incompatible transport or a policy refusal as unavailable; a rate limit as rate-limited; anything else as an error. What loads never reaches the chat store or the model.
