#!/bin/bash
# Local load experiment (#4116), measurement only. The container and the outside burners share one
# systemd user slice (create it first: systemd-run --user --unit=p4116-hold --slice=p4116.slice sleep 3600)
# and are pinned to the CPUs in PIN. Modes: none, inside (4 burners in the container), group1 (4 burners
# in one sibling cgroup), flat/grouped (4 burners in 4 sibling cgroups).
# usage: local.sh <mode none|flat|grouped|inside> <network none|default> <inner bash command>
set -u
MODE=$1; NET=$2; shift 2
export XDG_RUNTIME_DIR=/run/user/$(id -u)
REPO=${REPO:-$PWD}
IMAGE=mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
export TMPDIR=${TMPDIR:?set TMPDIR to a private directory that also holds the prepared fonts}
NODE=$(readlink -f "$(command -v node)")
SLICE=/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/p4116.slice
FONTHASH=$(sha256sum $REPO/scripts/captures/font-lock.json | cut -d' ' -f1)
BUN=$(readlink -f "$(command -v bun)")
BURN_SECONDS=${BURN_SECONDS:-240}; PIN=${PIN:-12-15}
UNITS=()
if [ "$MODE" = group1 ]; then
  U=p4116-burnall-$$
  systemd-run --user --quiet --slice=p4116.slice --unit=$U -p CPUAffinity=$PIN bash -c "for i in 1 2 3 4; do $NODE $REPO/scripts/measure-4116/burn.mjs $BURN_SECONDS & done; wait"
  UNITS+=($U)
elif [ "$MODE" = flat ] || [ "$MODE" = grouped ]; then
  for i in 1 2 3 4; do
    U=p4116-burn$i-$$
    if [ "$MODE" = grouped ]; then systemd-run --user --quiet --slice=p4116.slice --unit=$U -p CPUAffinity=$PIN -p CPUWeight=100 $NODE $REPO/scripts/measure-4116/burn.mjs $BURN_SECONDS
    else systemd-run --user --quiet --slice=p4116.slice --unit=$U -p CPUAffinity=$PIN $NODE $REPO/scripts/measure-4116/burn.mjs $BURN_SECONDS; fi
    UNITS+=($U)
  done
fi
INSIDE=0; [ "$MODE" = inside ] && INSIDE=4
ARGS=(run --rm --cgroup-parent=p4116.slice --ipc=host --user "$(id -u):$(id -g)" -v "$REPO:/repo"
  -v "$TMPDIR/brain-kit-feature-capture-fonts/$FONTHASH:/tmp/brain-kit-feature-capture-fonts/$FONTHASH:ro"
  -v "$BUN:/usr/local/bin/bun:ro" -v "$TMPDIR:$TMPDIR" -v "$REPO/scripts/measure-4116:/m:ro" -e "TMPDIR=$TMPDIR" -w /repo/packages/ui-kit -e HOME=/tmp
  -e VITE_CONFIG_NATIVE_IGNORE_WARNING=true -e VITE_PROBE_REPEATS -e INSIDE=$INSIDE -e PIN=$PIN -e BURN_SECONDS=$BURN_SECONDS)
[ "$NET" = none ] && ARGS+=(--network=none)
umask 000
sleep 0.5
echo "COND mode=$MODE pin=$PIN slice.cpu.max=$(cat $SLICE/cpu.max) slice.subtree_control=[$(cat $SLICE/cgroup.subtree_control)] burners_outside=${#UNITS[@]} burners_inside=$INSIDE"
( sleep 4; echo "DURING slice.subtree_control=[$(cat $SLICE/cgroup.subtree_control)] children: $(for d in $SLICE/*/; do printf '%s(w=%s,procs=%s) ' "$(basename $d | cut -c1-22)" "$(cat $d/cpu.weight 2>/dev/null || echo -)" "$(cat $d/cgroup.procs 2>/dev/null | wc -l)"; done)" ) &
docker "${ARGS[@]}" "$IMAGE" taskset -c $PIN bash -c 'for i in $(seq 1 $INSIDE); do node /m/burn.mjs $BURN_SECONDS & done; '"$*"'; code=$?; for p in $(jobs -p); do kill $p; done; exit $code'
CODE=$?
for U in "${UNITS[@]}"; do systemctl --user stop $U 2>/dev/null; done
echo "EXIT $CODE"
exit $CODE
