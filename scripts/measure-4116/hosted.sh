#!/usr/bin/env bash
# Measurement only (#4116). Never merged. Mirrors scripts/visual.mjs's container
# invocation, then times repeated passes of four representative specs with no
# load, with CPU burners inside the container and with CPU burners outside it.
set -u
IMAGE=mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
REPO=$PWD
PASSES=${PASSES:-3}
export BURN_SECONDS=${BURN_SECONDS:-900}
stamp() { echo "STAMP $1 t=${SECONDS}s"; }

stamp start
( time docker pull -q "$IMAGE" ) 2>&1 | grep -E "real|sha256"
( time bun scripts/capture.ts --prepare-fonts ) 2>&1 | grep -E "real|verified"
FONTHASH=$(sha256sum scripts/captures/font-lock.json | cut -d' ' -f1)
FONTS=/tmp/brain-kit-feature-capture-fonts/$FONTHASH
BUN=$(readlink -f "$(command -v bun)")

dock() { # dock <network> <inner command>
  local net=$1; shift
  local extra=(); [ "$net" = none ] && extra+=(--network=none)
  docker run --rm --ipc=host "${extra[@]}" --user "$(id -u):$(id -g)" -v "$REPO:/repo" -v "$FONTS:$FONTS:ro" \
    -v "$BUN:/usr/local/bin/bun:ro" -v /tmp:/tmp -e TMPDIR=/tmp -e HOME=/tmp -e VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
    -e INSIDE -e BURN_SECONDS -w /repo/packages/ui-kit "$IMAGE" \
    bash -c 'for i in $(seq 1 ${INSIDE:-0}); do node /repo/scripts/measure-4116/burn.mjs $BURN_SECONDS & done; '"$*"'; code=$?; for p in $(jobs -p); do kill $p; done; exit $code'
}
walk() { # print the CPU controller state from a cgroup up to the root
  local path=$1
  while :; do
    echo "FACT   cgroup ${path:-/} weight=$(cat /sys/fs/cgroup$path/cpu.weight 2>/dev/null || echo none) max=$(cat /sys/fs/cgroup$path/cpu.max 2>/dev/null | tr ' ' '/' || echo none) subtree_control=[$(cat /sys/fs/cgroup$path/cgroup.subtree_control 2>/dev/null)]"
    [ -z "$path" ] && break
    path=${path%/*}
  done
}

echo "FACT nproc=$(nproc) memMB=$(free -m | awk '/Mem:/{print $2}') kernel=$(uname -r)"
docker info --format 'FACT docker cgroupDriver={{.CgroupDriver}} cgroupVersion={{.CgroupVersion}} ncpu={{.NCPU}} rootless={{.SecurityOptions}}'
STEP_CGROUP=$(cut -d: -f3 /proc/self/cgroup | head -1)
echo "FACT step process cgroup $STEP_CGROUP"; walk "$STEP_CGROUP"
CID=$(docker run -d --rm "$IMAGE" sleep 60)
CPID=$(docker inspect -f '{{.State.Pid}}' "$CID")
CONTAINER_CGROUP=$(sudo cut -d: -f3 /proc/$CPID/cgroup | head -1)
echo "FACT container cgroup $CONTAINER_CGROUP"; walk "$CONTAINER_CGROUP"
docker kill "$CID" >/dev/null
( time docker run --rm "$IMAGE" true ) 2>&1 | grep real | sed 's/^/FACT container start+exit /'
stamp facts

for round in cold warm; do
  ( time node scripts/visual.mjs --project=visual --filter=contact-card-fact-keys.visual ) 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Duration|✓  |^real|Test Files" | sed "s/^/INVOCATION $round /"
done
stamp invocations

condition() { # condition <label> <burners inside> <burners outside>
  local label=$1 inside=$2 outside=$3 pids=()
  for i in $(seq 1 "$outside"); do node scripts/measure-4116/burn.mjs "$BURN_SECONDS" & pids+=($!); done
  echo "COND $label inside=$inside outside=$outside outsidePids=${pids[*]:-}"
  INSIDE=$inside dock default 'node /repo/scripts/measure-4116/bench.mjs' | sed "s/^/$label /"
  while read -r net project filter; do
    echo "SPEC $label $project $filter"
    INSIDE=$inside dock "$net" "node /repo/scripts/measure-4116/rerun.mjs $PASSES --project=$project $filter" 2>&1 \
      | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^LAP|^RESULT|✓  |FAIL|Error|×" | cut -c1-240 | sed "s/^/$label $project /"
  done <<'SPECS'
default visual contact-card-fact-keys.visual
default rail-fine dictation-notice.pointer
none ui-react-layout handoff-sheet.layout
default storybook SearchResultCard.stories
SPECS
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  stamp "$label"
}
condition none 0 0
condition inside "$(nproc)" 0
condition outside 0 "$(nproc)"
stamp end
