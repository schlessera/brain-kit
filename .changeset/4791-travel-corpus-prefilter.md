---
"@schlessera/brain-module-travel": patch
---

`brain travel validate`, `brain travel sync` and the exported `readTravelCorpus` no longer parse the frontmatter of every markdown file in the brain (#4791). A file is parsed only when its frontmatter block could declare a journey, trip or place: the block mentions `travel`, `trip` or `place`, or holds a backslash, so quoted, escaped, aliased and flow-mapping types are still found. As a result they no longer report malformed frontmatter in documents that cannot be travel documents, and such a note no longer stops `brain travel sync`; `brain validate` still reports it. A malformed travel document is reported as before. The places registry now builds every place's visit summary in one pass over the journeys and trips, with the same counts, deduplication, ordering and date bounds; `summarizePlaceVisits` is unchanged for single lookups.
