---
"@schlessera/brain": patch
---

The full-text search lane now matches a document that holds any of the query's content words, not only one that holds every word. A question such as "when is the bookshelf deadline" used to match nothing unless a document also contained "when", "is" and "the"; English stopwords are now dropped and the remaining words are ORed, with BM25 ranking the documents that share the most and rarest words first. A query that is one quoted phrase still matches as a phrase, and a query made only of stopwords still requires all of them.
