---
"@schlessera/brain": minor
---

Full-text search now finds a long document by the section that matches. A new chunk-level full-text index covers each chunk's heading and text. The full-text lane ranks a document by the better of two scores: its title, summary and tags, and its best-matching chunk. Its snippet comes from that chunk. Before, a 30-page document competed on whole-document BM25, whose length normalisation buried it behind a short note that mentioned the same words once. A document that matches only across its sections, such as a stopword-only query whose words sit in different chunks, is still found, and ranks after the rest.

**Schema 13.** `brain.db` gains the `chunks_fts` table and three triggers that keep it in step with `chunks`. The first writable open builds it from the chunks already indexed, so no reindex is needed. A read-only open of an older index searches whole documents, as before. On the fixture corpus's keyless retrieval set, two multi-hop queries move up (rank 2 → 1, and 5 → 2), and nothing moves down.
