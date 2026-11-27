---
"@schlessera/brain-ui-react": minor
---

The host Gmail read tools' results now render as the ui-kit Gmail components instead of raw tool output, on every backend, under the bare and Claude bridge tool names (the names the detail route accepts):

- **Search:** a page of threads as `GmailResultList`, in the view the result carries, under the query the call sent, with "Gmail has more matches" when there is a next page.
- **Read:** a thread as `GmailThread` and a message as `GmailMessage`, each in its view. A draft and the account's label list keep the tool's own output until the kit has components for them.
- **The fallback** (a draft, the label list, output that is not a result, or a result the history transport cut) shows hidden characters as their `‹U+XXXX›` markers and never turns a path in it into a file link.
- **Refusals** are drawn in the host's words.
- **The tool row** shows each call's effect class and view: `read · content view`, `read · structured view`, or `read · no result`; a call refused as invalid input, which was never classified, shows `no result`.

A message the host cut for the model offers "Show the rest", which loads its full body from the session's display-only detail route only when the reader asks. The rest is shown only when the full body begins with exactly the text Brain read; otherwise it reads as unavailable and nothing is spliced. Route errors read as the kit's states: not found as gone; unavailable, an incompatible transport or a policy refusal as unavailable; a rate limit as rate-limited; anything else as an error. Unmounting the card cancels a request in flight, and only the newest answer for a message is shown. What loads never reaches the chat store or the model.
