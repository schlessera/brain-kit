---
"@schlessera/brain": minor
---

`brain stats` now reads vectors through the shared `loadVecSupport` read path
instead of its own copy of it. A brain with no `vec_chunks` is still answered
without loading sqlite-vec and prints nothing on stderr. A brain that holds a
`vec_chunks` table on a host where sqlite-vec will not load now prints
`sqlite-vec not available: <cause>` on stderr, where it used to say nothing;
stdout, `--json` included, is unchanged.
