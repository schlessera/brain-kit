---
"@schlessera/brain": minor
"@schlessera/brain-ui-react": patch
---

Add optional `embed: false` type policies that retain keyword search, links and
audit while skipping chunk contexts and Markdown/image/PDF vectors. Ordinary
indexing removes existing vectors after a type opts out, even for unchanged
files; opting back in takes effect on the next embedding-enabled index.

Change nullable `health.embedding_coverage` to count only eligible chunks and
their vectors. Total chunk/vector inventory fields keep their meaning, and
zero eligible chunks remain unmeasured. This is an approved pre-1.0 semantic
contract change: consumers should use the supplied ratio rather than divide
the total counters. CLI and chat stats wording now names eligible chunks.
