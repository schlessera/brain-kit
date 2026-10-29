#!/usr/bin/env bash
set -euo pipefail
[ "${DIAG_SAMPLES:-}" = 4 ] || { echo 'SETUP_MISMATCH sample_bound' >&2; exit 1; }
# Fixed maximum; every non-clean outcome stops this shard. Independent shards finish separately.
for index in 1 2 3 4; do
  python3 .diagnostic/hosted.py invoke "$index" || exit "$?"
done
