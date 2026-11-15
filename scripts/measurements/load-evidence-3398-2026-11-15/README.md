# Historical load receipts (#3398)

These two 2026-10-24 receipts were copied byte for byte from main commit
`a9bcdbd6734c1733390570e2a68c10afde3b00a9` at their original repository paths. No test, script or CI step
reads them, and neither is a regression golden. They leave main under the
measurement-archive decision. Nothing was redacted, re-serialized or rerun.

`storage-history-load-2805.json` records storage allocation fixture load,
profiling, mutation and historical replay evidence for #2805 (#2818).
`parallel-recovery-load-2806.json` records parallel-session recovery fixture
load, mutation and historical replay evidence for #2806 (#2817).

`MANIFEST.json` records source provenance, sizes, hashes and git blobs.
From the archive root, verify both receipts with:

```sh
sha256sum -c scripts/measurements/load-evidence-3398-2026-11-15/SHA256SUMS
```

## Evidence limits

These are historical observations on the source, runtimes and shared loads
recorded in each receipt. They do not establish current product behavior or
current test performance. Their failed or incomplete replay qualifications
remain failures or incomplete qualifications; archiving adds no new proof.
The top-level manifest and checksums still describe only the original archive.
