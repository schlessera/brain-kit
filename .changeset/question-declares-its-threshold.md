---
"@schlessera/brain-ui-sdk": minor
---

A classification question now carries the confidence line its answer has to
clear, next to the options it offers. `ClassificationQuestion` gains a required
`threshold`, and the catalogue's transforms no longer name a line of their own:
the gate reads it off the question that was asked.

Nothing about when a block is drawn changes — every threshold keeps the value
it had, and the tests that prove each gate still refuses a below-threshold
answer are unmodified. What changes is that the two halves of one decision are
written in one place. They were written a hundred lines apart, and
`CONFIDENCE.swap` appeared in five separate transform bodies for the same
question, so a line moved in one place did not move in the other and a question
nobody gated looked exactly like a question gated at zero.

This matters now because a question id can be generated — the key-value run
asks one tone question per line — and anything that recovers a threshold by
parsing an id cannot express that.
