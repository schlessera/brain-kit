#!/usr/bin/env bash
# Offline, manually invoked research. Install the pinned fixture separately.
set -euo pipefail
mode=${1:?Use mcp or full}
case "$mode" in mcp|full) ;; *) exit 2 ;; esac
: "${SEARCH_RESEARCH_INSTALL:?Absolute path of isolated fixture installation}"
installation=$(realpath "$SEARCH_RESEARCH_INSTALL")
repo=$(git rev-parse --show-toplevel)
cd "$repo"
generated=tests/fixtures/host-search-1969.generated.ts
test ! -e "$generated"
owned=$(mktemp -d /var/tmp/brain-search-research-XXXXXX)
generated_owned=0
cleanup() { if test "$generated_owned" = 1; then rm -f "$generated"; fi; rm -rf "$owned"; }
trap cleanup EXIT
mkdir "$owned/home"
bun experiments/host-web-search/prepare.ts
generated_owned=1
timeout --kill-after=5s 60s env -i PATH="$PATH" LANG=C.UTF-8 HOME=/root SEARCH_RESEARCH_MODE="$mode" \
  SEARCH_RESEARCH_INSTALL="$installation" \
  bwrap --die-with-parent --unshare-net --bind / / --proc /proc --dev /dev --tmpfs /root \
  --bind "$owned/home" /root \
  bun --preload ./scripts/test-network-child-preload.ts \
  "$generated" default-home-state "$owned" > "$owned/out.jsonl"
python3 - "$owned/out.jsonl" <<'PY'
import json,sys
r=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
assert r['parentStateUnchanged'], 'PARENT_PI_STATE_PRESERVED'
assert not r['running'], 'WORKER_PROCESSES_EXITED'
assert len(r['hostPids']) >= 3, 'CONCURRENT_AND_RESUMED_REAL_WORKERS'
assert len(r['sessions']) == 2, 'TWO_REAL_SESSION_IDENTITIES'
assert all(f.get('outcome') == 'success' for f in r['frames'] if f['type']=='result'), 'WORKER_TURNS_SUCCEEDED'
print(json.dumps({k:r[k] for k in ['parentStateUnchanged','running','hostPids']}))
PY
