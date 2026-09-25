---
"@schlessera/brain": minor
---

`brain context` and the `brain_context` tool spend budget left over after the search hits on the top three hits' neighbours. First comes the nearest `_index.md` in each hit's directory or an ancestor. Then come the documents one link away from the hits in either direction, the ones more hits link to first. Each is one summary line under a `### Related` heading, never a body, and they are added only while they fit the budget. A document already in the output, or an archived one, is never added.
