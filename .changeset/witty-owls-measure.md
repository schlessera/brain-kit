---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

The classification pass now records what the classifier was confident about,
per question, so the swap thresholds can be moved on a distribution instead of
on a guess.

An answered pass writes one row per answered question to a new
`classification_confidence` table (migration 016, additive): the candidate it
was asked about, its kind, the question, the answer, its confidence, the line
that confidence had to clear, and whether the candidate ended up drawn as a
block or left as markdown. One pass shares one `recorded_at`, so
`(session_id, recorded_at, candidate_id)` names one candidate within one pass
and a question can be read conditioned on another answer about the same
candidate — which some of them must be, since the catalogue asks
`criteria_first` of every table including the ones the shape answer calls
`data`.
The write happens after the classifier call has resolved, so it takes none of
the call's 2 s budget, and a write that fails is a log line rather than a block
the reader does not get. Rows age out after 30 days.

`confidenceDistribution` (exported from `@schlessera/brain-ui-server`) reads it
back bucketed per candidate kind and question. `observeClassification` and
`QUESTION_THRESHOLD` are new in `@schlessera/brain-ui-sdk/server`; the catalogue
transforms now read their thresholds from `QUESTION_THRESHOLD` rather than
naming a figure inline, so a recorded confidence and the line it was compared
against cannot drift apart.

No threshold changed, and nothing leaves the machine.
