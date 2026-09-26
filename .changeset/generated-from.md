---
"@schlessera/brain": minor
---

Documents can declare where they come from with an optional `generated_from` frontmatter field. It holds a repo-relative path to the source, or a tool name when there is no file. `brain validate` reports any value that is not a non-empty string. `brain audit` reports a `propagation` issue when `generated_from` names a markdown document updated after this one. The heuristic reranker weights a generated document ×0.85, the same as `historical` relevance. Search results carry the value as `generatedFrom`. The index gains a `generated_from` column (`schema_version` 11). The first index run after the upgrade re-reads every markdown file to fill it, and unchanged chunks keep their vectors. The shipped `CONTRACT.md` tells agents to change a generated document's source rather than editing it by hand.
