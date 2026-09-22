---
"@schlessera/brain-ui-sdk": minor
---

The classification pass draws a contact card. A run of key-and-value lines
about one person, company or project — the shape a model types when it answers
"who is this?" — could previously become a receipt at best; the route D42
specified for it was never built. The classifier now picks which line holds the
name, the rest become the card's facts, and a run it cannot name is left as
markdown rather than given a label the text does not carry.

Values in a key-value run also carry a tone now, on receipt rows, stat tiles
and a contact's facts alike: a failed outcome reads red, a pending one amber,
an absent one dim. The tone needs the higher confidence bar every other tone
needs, and is asked only of a run of eight lines or fewer.

No new block kind and no protocol change — both arrive through the existing
`message_blocks` frame as variants `show_block` already carried.

`trend` deliberately gets no route: with `bars`, it is one of the two block
kinds whose payload is numbers rather than the answer's own text, and deriving
those from prose is not a judgment the classifier is asked to make. D45 records
the reasoning.
