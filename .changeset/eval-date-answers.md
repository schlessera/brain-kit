---
"@schlessera/brain": minor
---

`brain eval` can now measure answers that change over time. A query may give `expect.select` instead of `expected`: a selector over a frontmatter date field (`deadline`, `next_review`, …) that picks the right documents at the run's `now`. `now` comes from the set's `{"now": …}` header, then `--now`, then the wall clock, and it is also what search measures recency from. A query may list superseded paths as `stale`. Rows and `per_query` then report `current_first`: whether search ranks the current document above them. A selector that selects nothing refuses the run.
