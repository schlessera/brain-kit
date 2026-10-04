---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
---

BREAKING: correct public `SearchResult.tags` to `string | null` and optional
`RerankCandidate.tags` to `string | null`, matching existing untagged results.
TypeScript clients and external rerankers must handle null (for local text,
use `tags ?? ""`). CLI/MCP/HTTP values, reranker inputs, built-in provider
requests and rankings stay unchanged. Correct the server's private list mirror
to the existing nullable/string fields, without an invented created field.
