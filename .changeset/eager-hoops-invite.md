---
"@schlessera/brain": patch
---

Fix three issues surfaced by migrating a real brain repo onto the published packages.

- **User `classifierHints` no longer vanish when a module claims the same type.**
  `configuration.md` promises "modules contribute theirs; yours layer on top", but
  the first source to mention a type won outright — so enabling
  `@schlessera/brain-module-speaking` silently discarded a user's own `conference`
  vocabulary. Sources now accumulate per type; rule order still follows first
  appearance, which is what a module's position in `modules` expresses.
- **`brain doctor` reported "no vectors stored" for healthy indexes.** The embeddings
  check counted rows in `vec_chunks` without loading sqlite-vec into that connection,
  so every query threw and the count read as zero. It now loads the extension at the
  dimension the index was built with, and distinguishes "extension unavailable" from
  "genuinely empty".
- **Export `rerank` / `getDefaultRerankerMode`.** A retrieval-quality harness can now
  score rerank-on and rerank-off orderings from one candidate list instead of
  re-embedding the query for each variant.
