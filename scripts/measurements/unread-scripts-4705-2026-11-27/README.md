# Unread script inputs (#4705)

These two files were copied byte for byte from main commit
`87b96b10ce178f1444bd3163ed95bd2c21ab8940` at their original repository paths. They leave main under
the measurement-archive decision: no current test, script, eval or CI step
reads either one, and neither is a regression golden. Nothing was redacted,
re-serialized or rerun.

`scripts/native-proof/dedupe-experiment.ts` exports `runDedupeExperiment`, the
owned reference-pool cells cited by `docs/plans/repository-storage-dedupe.md`
(#3737). Nothing imported it and it had no entry point, so it could not be run
from the tree; the call site that produced the cited numbers was never
committed.

`scripts/unit-shard-observation.json` holds the partial completed-file
observations of the first two-partition hosted unit runs (#1327), cited by
`docs/decisions/ci-utility.md`. Scheduling reads `scripts/test-shard-costs.json`
instead.

`MANIFEST.json` records source provenance, sizes, hashes and git blobs.
From the archive root, verify both files with:

```sh
sha256sum -c scripts/measurements/unread-scripts-4705-2026-11-27/SHA256SUMS
```

## Evidence limits

These are historical artifacts. The experiment source records how the cited
pool cells were driven, not a reproducible entry point, and the observation
file records one run's partial timings. Neither establishes current product
behaviour or current test performance; archiving adds no new proof. The
top-level manifest and checksums still describe only the original archive.
