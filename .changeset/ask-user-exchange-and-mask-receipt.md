---
"@schlessera/brain-ui-react": minor
---

`ask_user` is an exchange, and a mask is a receipt (D38 §1, §2).

The hand-drawn ask-user card with its collapsed summary row retires for the
kit `AskUserCard`, one per question, in the three states the design ruled:
`pending` (options, one focus stop; "Other" opens the kit's field in place of
the Submit row), `answered` (the chosen answer with when — the alternatives
are gone, not dimmed, because they were never the record) and `typed`. All
three stay in the transcript at full contrast; nothing rolls up. A dismissed
question keeps its card with no options and a neutral note.

`typed` is new behaviour: a composer send while a question is pending is the
ANSWER to it. The text binds to the first question, goes out as
`ask_user_response`, and the card quotes what it took under a neutral border —
nothing is sent as a chat message. The exchange records `typed` and
`answeredAt`; both are live-only, because the persisted tool output carries
neither, so a resumed transcript shows a typed answer as a plain answered one
with no time rather than one it made up.

`request_image_mask` renders through its contract like the location card: a
hatched source thumb (no remote image inline) above a kit `Receipt` with the
rows its payload actually carries — source and mask — and a red mono
`Callout` stating a declined mask from the result's own words. The design
also draws a region and a coverage figure; the payload has neither yet, and
the card invents neither.
