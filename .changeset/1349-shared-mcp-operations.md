---
"@schlessera/brain": patch
---

`brain doctor` now decides whether the index is stale with the same check the MCP read tools use for their staleness warning, so both always report the same count. The core MCP tools run on shared operations under the hood; their names, inputs, descriptions and results do not change.
