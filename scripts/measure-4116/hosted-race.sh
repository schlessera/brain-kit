#!/usr/bin/env bash
# Measurement only (#4116). Never merged. Repeats the #3953 race (the #3954 wait
# reverted in a copy of the spec) with no load, with CPU burners inside the
# container and with CPU burners outside it.
set -u
IMAGE=mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
REPO=$PWD
PASSES=${PASSES:-8}
export BURN_SECONDS=${BURN_SECONDS:-600}
docker pull -q "$IMAGE" >/dev/null
bun scripts/capture.ts --prepare-fonts | tail -1
FONTHASH=$(sha256sum scripts/captures/font-lock.json | cut -d' ' -f1)
FONTS=/tmp/brain-kit-feature-capture-fonts/$FONTHASH
BUN=$(readlink -f "$(command -v bun)")
dock() {
  docker run --rm --ipc=host --network=none --user "$(id -u):$(id -g)" -v "$REPO:/repo" -v "$FONTS:$FONTS:ro" \
    -v "$BUN:/usr/local/bin/bun:ro" -v /tmp:/tmp -e TMPDIR=/tmp -e HOME=/tmp -e VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
    -e INSIDE -e BURN_SECONDS -w /repo/packages/ui-kit "$IMAGE" \
    bash -c 'for i in $(seq 1 ${INSIDE:-0}); do node /repo/scripts/measure-4116/burn.mjs $BURN_SECONDS & done; '"$*"'; code=$?; for p in $(jobs -p); do kill $p; done; exit $code'
}
condition() { # condition <label> <burners inside> <burners outside>
  local label=$1 inside=$2 outside=$3 pids=()
  for i in $(seq 1 "$outside"); do node scripts/measure-4116/burn.mjs "$BURN_SECONDS" & pids+=($!); done
  echo "COND $label inside=$inside outside=$outside"
  INSIDE=$inside dock "node /repo/scripts/measure-4116/rerun.mjs $PASSES --project=ui-react-layout measure-3953-race" 2>&1 \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^LAP|^RESULT|   ×|AssertionError" | cut -c1-220 | sed "s/^/$label /"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  echo "STAMP $label t=${SECONDS}s"
}
condition none 0 0
condition inside "$(nproc)" 0
condition outside 0 "$(nproc)"
condition inside-again "$(nproc)" 0
