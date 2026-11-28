---
"@schlessera/brain-ui-server": patch
---

Three recorder-reply paths now read replies through the same strict parser as the rest of egress recording (#5038). A hosted writer that answers a terminal exposure with no reply stops the turn; only a legacy recorder may answer with nothing. The tool-result collector parses its terminal record's reply, so an `{error}` reply neither completes the result nor discharges its obligation and leaves the chat a recorded gap. Egress audit replies are awaited the same way whether they are values or promise-like objects from another realm.
