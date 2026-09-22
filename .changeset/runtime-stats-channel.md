---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

`GET /api/activity/stats?days=N` — the runtime half of a stats page. It
reports what the server's own database holds: lifetime session, turn and cost
figures from the session catalog; a windowed run, token and cost summary from
the activity rollups, labelled with the days it actually covers, where detail
pruning starts and how many runs in the window are already rollup-only; the
averages a caller would otherwise recompute; and the database's size. Cost
sums stay sums of known values with the excluded count in `unpricedRuns`, and
an average is `null` rather than `0` whenever its sum is incomplete or its
denominator is zero. `GET /api/brain/stats` is unchanged and stays the corpus
channel. The shape is `ActivityRuntimeStats` in
`@schlessera/brain-ui-sdk/protocol`.
