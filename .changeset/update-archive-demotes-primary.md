---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-module-speaking": patch
---

Archiving through `brain_update` (MCP and the pi backend) now applies the same relevance rule as `brain archive`: setting `status: "archived"` turns a `primary` or missing relevance into `historical`, and the result's `changes` lists `"relevance"`. An explicit `secondary` or `historical` stays, and so does a relevance given in the same call. Before, a status edit left the document claiming `primary`, and `brain validate` then warned about a state the product had written. The rule is exported from `@schlessera/brain` as `relevanceOnArchive`. The conference-aftermath skill now archives with `brain archive` instead of setting `status: archived` by hand.
