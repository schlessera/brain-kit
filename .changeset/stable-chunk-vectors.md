---
"@schlessera/brain": minor
---

Editing a document no longer pays to re-embed the parts that did not change. An incremental index now matches a changed document's new chunks to its old ones by the text they are embedded from. A matched chunk keeps its row, context and vector, only chunks without a vector are embedded, and a kept vector's archive flag and type follow the document. The document row is updated in place, so its id stays stable. `brain index --force --embeddings` holds the markdown vectors in memory before it wipes the index, and reuses any whose embedding text is unchanged, as long as the configured provider and dimensions are the ones that produced them. With a different provider it still re-embeds everything. `embeddings` in `brain index --json` still counts the vectors written, including reused ones written back after `--force`.
