---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": minor
---

Search's recency boost now follows your own document types. A type spec takes an optional `halfLifeDays`; without it, a type decays over its `staleDays`, else 365 days. The built-in half-life table named types from one particular taxonomy, so in most brains every type fell through to 365 days. It is gone: only the four core types carry a default half-life (`context` 30, `note` 60, `index` 365, `identity` 1095). `SearchDeps` and `RerankerConfig` take an optional `taxonomy`, and `brain search`, the MCP server, `brain context`, `brain process` and the pi backend pass the brain's.
