---
"@schlessera/brain": minor
---

**Breaking (`brain stats --json`):** `embeddings` is now `number | null`.

- `null` when the brain has a `vec_chunks` table that could not be counted, because sqlite-vec did not load on this host. It used to read `0`, which looked the same as a brain holding no vectors.
- A brain with no `vec_chunks` still reports `0`.
- Consumers doing arithmetic on the field must handle `null`.
- `brain stats --human` prints `Embeddings: n/a` in that case.
- The `--help` caveat about the field reading `0` is gone. So is the matching note in `docs/cli.md` and `docs/integration-contract.md`.

Ruled for 0.37.0 on #169.
