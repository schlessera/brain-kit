---
"@schlessera/brain": minor
---

A table inside a list item or a blockquote that is over the chunk size limit now splits the way a top-level table does. Every piece that opens inside the table starts with its header and separator rows, carrying the container's prefix (`> `, the list indentation, never the list marker), and a cut never falls between the header row and the separator. Before, continuation pieces started on a bare data row. This holds at any nesting depth.

**One-time cost.** The chunker version moves to 3, so the first index run on this version re-chunks every document once. Chunks whose text comes out the same keep their vectors. The changed ones get new chunk contexts and vectors on the next `brain index --embeddings`, which are paid calls.
