# Candidate extraction controls

Private report-only preparation for #849. The natural workload and the original
parser controls are separate author-provisional sets. No provider entry,
credential adapter, generic extraction seam or automatic file writer is shipped.
The current complete workflow comparison is blocked by #1275 and included Claude
availability. An explicit SDK fixture policy does not replace that baseline.

Use Bun 1.4.2 and run the root test script with the candidate-extraction tests.
The actual offline native control is a separate manual entry:

```sh
rtk proxy python3 scripts/evals/candidate-extraction/offline-launch.py \
  --bun /path/to/verified/bun --output /fresh/protected/output
```

The launcher refuses an existing output directory, strips inherited environment,
creates distinct network/user/PID namespaces, mounts source/runtime read-only and
raises only loopback. Four fresh native children exercise both domain notices,
outside-read/write denial, no-tools reporting and an inadmissible scripted review.
Raw requests, response SSE, stdio, terminal usage and real close/drain are retained.
These manual controls are not claimed to run in automatic CI.

`prepare.ts` takes a fresh protected destination and the current verification
receipt. It rejects semantic source drift or a native proof from a different
full owned closure. The resulting full-source/whole-case packet contains exact
notice bytes, context, provisional role/parser/full-task expectations, neutral
brain inputs, all schemas and complete relevant shipped skill/CLI/module code.
Complete accounting and semantic review stay independent requirements; bytes and
hashes alone prove neither token capacity nor approval. Scripted labels do not
calibrate a live per-field gate. The raw review validator rejects offline and
metadata-only approvals and binds literal collected prompt/auth/runtime/physical
evidence to the packet identity. It has no dispatcher.

The owned closure/native tee/review verifier were copied from the corrected #848
private preparation and adapted locally. Their source provenance does not grant
semantic approval to this experiment. The original parser controls and research
consumer tests remain unchanged. Any future production helper requires both
concrete consumers and the original empirical comparison; no shared seam follows
from these keyless checks. #1239 tracks the pricing-source ambiguity separately.
