#!/usr/bin/env bash
# Ephemeral hosted runner only: preserve the pre-existing real-runtime CI setup.
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install --yes bubblewrap iproute2
# Unit partitions retain their existing prerequisites; the runtime job alone
# prepares the native image before entering its network-disabled proof.
if [ "${1:-}" = "--native" ]; then
  sudo apt-get install --yes btrfs-progs build-essential
  sudo modprobe loop
  sudo modprobe btrfs
  docker build --file scripts/native-proof/Dockerfile --tag brain-kit-native-runtime:1 scripts/native-proof
  if [[ "$(docker info --format '{{json .SecurityOptions}}')" == *"name=apparmor"* ]]; then
    sudo apt-get install --yes apparmor
    sudo apparmor_parser --replace --warn=all scripts/native-proof/apparmor.profile
  fi
fi
# Ubuntu's AppArmor userns knob prevents the offline namespace harness. This
# runner is disposable; tests still run with their own network isolation.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev /usr/bin/true
if [ "${1:-}" != "--native" ]; then
  # Fail before the expensive unit phase if private ledger mounts or nested
  # native workers are unavailable. The entry drops its setup capabilities.
  UNIT_NAMESPACE_LEDGER=$(mktemp -d)
  trap 'rmdir "$UNIT_NAMESPACE_LEDGER"' EXIT
  unshare --user --map-current-user --keep-caps --mount \
    bash scripts/unit-worker-entry.sh "$UNIT_NAMESPACE_LEDGER" \
    bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev /usr/bin/true
  rmdir "$UNIT_NAMESPACE_LEDGER"
  trap - EXIT
fi
PROOF_CHROME=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)
if [ -z "$PROOF_CHROME" ]; then echo "Real Chrome is required for hosted runtime proof" >&2; exit 1; fi
"$PROOF_CHROME" --version
echo "PUPPETEER_EXECUTABLE_PATH=$PROOF_CHROME" >> "$GITHUB_ENV"
