#!/usr/bin/env bash
# Deliberate Linux offline proof, with the real browser online signal (#2401).
set -euo pipefail

refuse() {
  printf 'offline-test: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: scripts/test-offline.sh [--mount] [--] command [argument ...]\n'
  printf 'Creates private user/network namespaces; --mount also isolates mounts.\n'
}

# This runs in a new shell after setpriv, immediately before the given command.
run_command() {
  local key value rest seen=0
  while read -r key value rest; do
    case "$key" in
      CapInh:|CapPrm:|CapEff:|CapBnd:|CapAmb:)
        printf 'offline-test: %s %s\n' "$key" "$value" >&2
        [[ "$value" =~ ^0+$ ]] || refuse "$key must be zero before starting the command"
        ((seen+=1))
        ;;
    esac
  done < /proc/self/status
  [[ "$seen" == 5 ]] || refuse 'could not verify all five capability sets'
  exec "$@"
}

setup_namespace() {
  local caller_user=$1 caller_net=$2 caller_mount=$3
  shift 3
  local current_user current_net current_mount ipv4 ipv6
  current_user=$(readlink /proc/self/ns/user)
  current_net=$(readlink /proc/self/ns/net)
  current_mount=$(readlink /proc/self/ns/mnt)
  # Check before touching any interface, even if namespace creation misbehaved.
  [[ -n "$current_user" && "$current_user" != "$caller_user" ]] || refuse 'user namespace is not separate from the caller'
  [[ -n "$current_net" && "$current_net" != "$caller_net" ]] || refuse 'network namespace is not separate from the caller'
  if [[ -n "$caller_mount" ]]; then
    [[ -n "$current_mount" && "$current_mount" != "$caller_mount" ]] || refuse 'mount namespace is not separate from the caller'
  fi
  printf 'offline-test: user=%s net=%s mount=%s\n' "$current_user" "$current_net" "$current_mount" >&2

  # Autoloading dummy can create dummy0 in the initial (host) network namespace.
  [[ -d /sys/module/dummy ]] || refuse 'dummy driver is not initialized; refusing module autoload that can change host interfaces'
  ip link set dev lo up
  ip link add name proof-dummy type dummy
  # Otherwise link-up creates an IPv6 link-local route in the main table.
  ip link set dev proof-dummy addrgenmode none
  ip -4 address add 198.18.0.1/32 dev proof-dummy noprefixroute
  ip link set dev proof-dummy up

  printf 'offline-test: links and addresses\n' >&2
  ip -details link show >&2
  ip address show >&2
  ipv4=$(ip -4 route show table main)
  ipv6=$(ip -6 route show table main)
  printf 'offline-test: IPv4 main routes\n%s\noffline-test: IPv6 main routes\n%s\n' "$ipv4" "$ipv6" >&2
  [[ -z "$ipv4" ]] || refuse 'IPv4 main route table must be empty before starting the command'
  [[ -z "$ipv6" ]] || refuse 'IPv6 main route table must be empty before starting the command'

  # --keep-caps is needed for setup, but retained capabilities make bwrap refuse.
  exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
    bash -euo pipefail -c "$(declare -f refuse run_command); run_command \"\$@\"" offline-test "$@"
}

mount_options=()
while (($#)); do
  case "$1" in
    --mount) mount_options=(--mount --propagation=private); shift ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    -*) usage >&2; refuse "unknown option: $1" ;;
    *) break ;;
  esac
done
(($#)) || { usage >&2; refuse 'a command is required'; }
[[ "$(uname -s)" == Linux ]] || refuse 'Linux with permitted user/network namespaces is required'
for tool in unshare ip setpriv readlink bash; do
  command -v "$tool" >/dev/null || refuse "required tool is unavailable: $tool"
done
caller_user=$(readlink /proc/self/ns/user)
caller_net=$(readlink /proc/self/ns/net)
caller_mount=''
if ((${#mount_options[@]})); then caller_mount=$(readlink /proc/self/ns/mnt); fi
[[ -n "$caller_user" && -n "$caller_net" ]] || refuse 'could not read caller namespace identities'

# Pass arguments separately, and leave stdin, cwd, environment, UID and umask alone.
# Functions travel as trusted script source, without an externally callable setup mode.
exec unshare --user --map-current-user --keep-caps --net "${mount_options[@]}" -- \
  bash -euo pipefail -c "$(declare -f refuse run_command setup_namespace); setup_namespace \"\$@\"" \
  offline-test "$caller_user" "$caller_net" "$caller_mount" "$@"
