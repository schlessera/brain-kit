#!/usr/bin/env bash
# Root-only btrfs dead-root kernel trace for the disposable native proof host.
# `start <output>` records which task queues each deleted checkpoint for the
# cleaner, before or after the delete's commit; `stop` removes every probe.
set -euo pipefail
tracing=/sys/kernel/tracing instance=/sys/kernel/tracing/instances/brain-kit-dead-root state=/run/brain-kit-dead-root
probes=(
  'p:brainkit/delete btrfs_delete_subvolume name=+0(dentry->d_name.name):string comm=$comm'
  'p:brainkit/dead_root btrfs_add_dead_root root=root->root_key.objectid comm=$comm'
  'p:brainkit/commit_async btrfs_commit_transaction_async comm=$comm'
  'p:brainkit/drop btrfs_drop_snapshot root=root->root_key.objectid comm=$comm'
)
stop() {
  [ -d "$instance" ] || return 0
  echo 0 > "$instance/tracing_on"
  # Stop the consuming reader, then append whatever it had not yet consumed.
  read -r reader output < "$state"
  kill "$reader" 2>/dev/null || true
  # An unreaped (zombie) reader has already closed trace_pipe.
  for _ in $(seq 50); do
    state_line=$(cat "/proc/$reader/stat" 2>/dev/null) || break
    [[ "${state_line##*) }" == Z* ]] && break
    sleep 0.1
  done
  grep -v '^#' "$instance/trace" >> "$output" || true
  echo '!stacktrace' > "$instance/events/brainkit/dead_root/trigger" 2>/dev/null || true
  echo 0 > "$instance/events/brainkit/enable" 2>/dev/null || true
  rmdir "$instance"; rm -f "$state"
  for probe in "${probes[@]}"; do echo "-:${probe#p:}" | cut -d' ' -f1 >> "$tracing/kprobe_events"; done
}
case "${1:-}" in
  start)
    output=$(realpath -m "${2:?usage: dead-root-trace.sh start <output>|stop}")
    mountpoint -q "$tracing" || mount -t tracefs nodev "$tracing"
    if [ -d "$instance" ]; then echo "dead-root trace already running" >&2; exit 1; fi
    for probe in "${probes[@]}"; do echo "$probe" >> "$tracing/kprobe_events"; done
    mkdir "$instance"
    echo mono > "$instance/trace_clock"
    echo 8192 > "$instance/buffer_size_kb"
    echo stacktrace > "$instance/events/brainkit/dead_root/trigger"
    echo 1 > "$instance/events/brainkit/enable"
    mkdir -p "$(dirname "$output")"
    printf '# kernel %s; probes: delete dead_root commit_async drop; clock mono\n' "$(uname -r)" > "$output"
    chmod 0644 "$output"
    setsid cat "$instance/trace_pipe" >> "$output" < /dev/null &
    echo "$! $output" > "$state"
    echo 1 > "$instance/tracing_on"
    ;;
  stop) stop ;;
  *) echo "usage: dead-root-trace.sh start <output>|stop" >&2; exit 2 ;;
esac
