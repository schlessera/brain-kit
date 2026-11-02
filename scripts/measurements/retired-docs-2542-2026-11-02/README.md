# Retired documentation experiments and replay evidence — 2026-11-02 (#2511, #2512)

Four files that nothing in the main tree reads any more. They moved here under
the measurement-archive rule
(`docs/decisions/measurement-archive.md` on `main`): historical output and
finished experiments leave `main`, and a link from a document is a pointer,
not a consumer.

Each file sits at its **original repository path**, byte for byte. The bytes
were copied with `git show <commit>:<path>` from main commit
`5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0`. The integration branch they were
removed on, `epic/2542-dead-code` at `ac3cab77a7f599161990968d642c6e22bf41af3d`,
holds the same git blobs. Nothing was redacted, re-serialised or rerun.

| Original path | Role | Introduced by | Why it left `main` |
| --- | --- | --- | --- |
| `docs/plans/storage-accounting-experiment.py` | Finished fixture experiment for the storage-accounting discovery (#1780) | `1ed6e3d431fac8fa28c217d695a8ab412dd22fe4` | Its only reader was the retired plan `docs/plans/storage-accounting.md`; no test, script or CI step runs it. |
| `docs/plans/storage-growth-experiment.ts` | Finished offline rule-qualification traces for the storage-growth design (#2014) | `65ed23dc942ecaccbe86ae1beb4af6eeb3ad3eb5` (last changed `caae12da2e678dd4720bf112e93ef21812cfdc18`) | Its only reader was the retired plan `docs/plans/storage-growth.md`; no test, script or CI step runs it. |
| `docs/process/evidence/independent-test-replay.json` | 100-PR replay of independent Bun test-leaf selection (#2147, closing #2124) | `d6b527290fe203fca7f653464895e92775ec422f` | Referenced by nothing; one note inside `docs/process/evidence/test-wait-review-partition.json` names it in passing. |
| `docs/process/evidence/browser-input-closure-replay.json` | 100-PR replay of conservative browser proof input discovery (#2152) | `b6d7391de6bab96143451b0a13bc381ae7b4ebd2` | Referenced by nothing. |

`MANIFEST.json` records each file's size, SHA-256, git blob, introducing and
last-changing commit, and any source commit the file recorded about itself
(`measuredSource`). `SHA256SUMS` checks the four files from the archive root:

```sh
sha256sum -c scripts/measurements/retired-docs-2542-2026-11-02/SHA256SUMS
```

To check the bytes against `main` as well:

```sh
git fetch origin <archive-commit> 5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0
git show <archive-commit>:scripts/measurements/retired-docs-2542-2026-11-02/SHA256SUMS | while read -r sum path; do
  a=$(git show "<archive-commit>:$path" | sha256sum | cut -d' ' -f1)
  b=$(git show "5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0:$path" | sha256sum | cut -d' ' -f1)
  [ "$a" = "$sum" ] && [ "$b" = "$sum" ] || echo "MISMATCH $path"
done
```

## Running the experiments

Both experiments are self-contained and create only temporary Odysseus
fixtures. Restore them at their original paths in a checkout first:

```sh
git fetch origin <archive-commit>
git restore --source <archive-commit> -- docs/plans/storage-accounting-experiment.py docs/plans/storage-growth-experiment.ts
python3 -B docs/plans/storage-accounting-experiment.py
bun docs/plans/storage-growth-experiment.ts
```

The plans that described their conditions and recorded results are readable
at `5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0`:
`docs/plans/storage-accounting.md` ("Synthetic experiment and evidence") and
`docs/plans/storage-growth.md` ("Synthetic decision examples").

## Evidence limits

The experiments qualify design rules on synthetic fixtures. They are not
production history, runtime proof, benchmarks or forecast-accuracy evidence,
and running them again creates a new observation rather than replacing the
recorded one. The two replays describe CI selection behaviour over the first
100 PRs merged at their 2026-10-16 cutoff, on the selector source they record.
They make no claim about the current selector.
