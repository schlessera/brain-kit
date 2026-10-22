# Container-only projection of one run from a stable host directory bind.
set -eu
run=$1
kind=$2
shift 2
case "$run" in run-*) ;; *) echo 'Invalid native proof run name' >&2; exit 2 ;; esac
case "$run" in *[!a-zA-Z0-9_-]*) echo 'Invalid native proof run name' >&2; exit 2 ;; esac
mkdir /proof
mount --bind "/proof-runs/$run" /proof
if [ "$kind" = identity ]; then
  mkdir /fixture-variants
  mount --bind "/fixture-runs/$run" /fixture-variants
  mount -o remount,bind,ro /fixture-variants
  readonly_file() {
    if [ ! -e "$2" ]; then touch "$2"; fi
    mount --bind "/fixture-variants/$1" "$2"
    mount -o remount,bind,ro "$2"
  }
  readonly_file identity-helper /fixture-helper
  readonly_file helper.py /helper.py
  readonly_file filesystem-filter.py /filter.py
  readonly_file setup.sh /setup.sh
  boot=false
  for variant in "$@"; do
    [ "$variant" != -- ] || break
    [ "$variant" != boot ] || boot=true
  done
  while [ "$1" != -- ]; do
    case "$1" in
      db) readonly_file db-repeat-output.fixture.ts /repo/packages/ui-sdk/src/server/worker-native-output.ts ;;
      boot) readonly_file boot-scratch-prune.fixture.ts /repo/packages/ui-server/src/cron/scratch-prune.ts ;;
      prune)
        if [ "$boot" = false ]; then readonly_file scratch-prune.fixture.ts /repo/packages/ui-server/src/cron/scratch-prune.ts; fi
        readonly_file host-boundary.fixture.ts /repo/packages/ui-server/src/brain/host-boundary.ts ;;
      inventory) readonly_file maintenance-git.fixture.ts /repo/packages/ui-server/src/brain/maintenance-git.ts ;;
      scratch) readonly_file scratch-mask-identity-ws.fixture.ts /repo/packages/ui-sdk/tests/fixtures/ordinary-identity-ws.ts ;;
      *) echo 'Invalid identity proof variant' >&2; exit 2 ;;
    esac
    shift
  done
  shift
elif [ "$kind" != host ]; then
  echo 'Invalid native proof kind' >&2
  exit 2
fi
exec "$@"
