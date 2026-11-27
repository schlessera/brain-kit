---
"@schlessera/brain": patch
---

Internal (#4714): the wiki-link walk behind `brain_graph` and the query API's `readLinkWalk` is one function. `brain_graph` keeps its own read transaction around it and now compiles the walk's statements once per connection instead of once per visited document and direction. Both results are unchanged.
