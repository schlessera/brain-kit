#!/usr/bin/env bash
# Inside an already private user/mount namespace; preserve UID, PID and /tmp.
set -euo pipefail
unit_ledger=$1
shift
unit_budget="/tmp/brain-maintenance-budget-$(id -u)"
unit_umask=$(umask)
umask 077
if [ -L "$unit_budget" ] || { [ -e "$unit_budget" ] && [ ! -d "$unit_budget" ]; }; then
  echo 'Unit maintenance ledger target must be an owned directory' >&2
  exit 1
fi
mkdir -p -- "$unit_budget"
test -O "$unit_budget"
mount --make-rprivate /
mount --bind "$unit_ledger" "$unit_budget"
umask "$unit_umask"
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
