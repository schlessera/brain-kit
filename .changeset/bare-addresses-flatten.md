---
"@schlessera/brain-ui-sdk": minor
---

A bare email address or URL no longer keeps an answer's table, list, quote or
key-value run out of the classification pass. GFM turns a bare address into a
link, and any link used to reject the whole candidate; now a link whose text is
its own destination flattens to that text, and a `mailto:` address reads as the
bare address. A run of facts about a person that carries an email can become a
contact card. A labelled link (`[the docs](https://…)`) still leaves its
candidate as markdown, because flattening it would lose where it points.
