---
"@schlessera/brain": minor
---

A newer document can say which one it replaces. The new `supersedes:` frontmatter field takes a wiki-link target or a list of them (`supersedes: "[[bookshelf-plan]]"`), resolved like a wiki-link in the body, aliases included. Search then ranks the replaced document lower: its score is multiplied by 0.85 after fusion and reranking, in every mode, `rerank: none` included. It stays in the results, and each of its results carries `supersededBy`, the path of the document that replaced it, in `brain search --json` and `brain_search`. A filter-only search marks it too, without reordering. `brain validate` reports as errors a malformed, empty or blank value, a target that does not resolve, and every document on a cycle.

**Schema 12.** `brain.db` gains a `supersedes` table, rebuilt on every index run like `links`. The migration has the next `brain index` re-read every markdown file once, so an existing brain picks the field up without `--force`.
