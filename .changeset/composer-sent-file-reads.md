---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": minor
---

Sent composer originals now show what the agent read of them (#3155). A sent row reads `not read yet`, `read p. 1–3`, `read`, `partly read p. 1–3`, `read stopped at 1.0 KB`, `no text found · may be scanned`, `couldn't read: password-protected` or `damaged file`, `couldn't read`, `original changed since sending`, or `no reader for this kind of file`. The state comes only from the host's read records (#3589): a session's records are fetched when its view opens and after each reconnect, and each new read updates its row from an `attachment_read` frame. Pages read across several turns are combined. Until the host's records arrive, and on a host without `attachmentReads`, a row claims neither "read" nor "not read yet".

`BrainUiClient` now declares `attachmentReads` in its `client_hello`, so its consumers can receive `attachment_read` frames. `serverMessageSchema` already parses them.
