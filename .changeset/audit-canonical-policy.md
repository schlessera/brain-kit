---
"@schlessera/brain": minor
---

`brain audit` checks the canonical documents every session reads first, against a new optional `brain.config` key, `taxonomy.canonicalPolicy`. It is set per canonical key with `maxTokens` and `reviewDays`, and the only default is `currentFocus: { maxTokens: 1000 }`. Three new warning categories come with it:

- `budget`: a canonical document over its token budget.
- `review-overdue`: any non-archived document whose `next_review` has passed, or a canonical document past its `reviewDays` cadence.
- `past-date`: a line in a canonical document with a policy that names a day before today, reported with its line number.

`brain maintain`'s audit counts include them. `/brain-init` now writes a policy for the focus document.
