#!/usr/bin/env bash
# Ephemeral hosted runner only: preserve the pre-existing real-runtime CI setup.
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install --yes bubblewrap iproute2
# Unit partitions retain their existing prerequisites; the runtime job alone
# prepares the native image before entering its network-disabled proof.
if [ "${1:-}" = "--native" ]; then
  sudo apt-get install --yes btrfs-progs
  sudo modprobe loop
  sudo modprobe btrfs
  docker build --file scripts/native-proof/Dockerfile --tag brain-kit-native-runtime:1 scripts/native-proof
  if [[ "$(docker info --format '{{json .SecurityOptions}}')" == *"name=apparmor"* ]]; then
    sudo apt-get install --yes apparmor
    sudo apparmor_parser --replace --warn scripts/native-proof/apparmor.profile
  fi
fi
# Ubuntu's AppArmor userns knob prevents the offline namespace harness. This
# runner is disposable; tests still run with their own network isolation.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev /usr/bin/true
PROOF_CHROME=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)
if [ -z "$PROOF_CHROME" ]; then echo "Real Chrome is required for hosted runtime proof" >&2; exit 1; fi
"$PROOF_CHROME" --version
echo "PUPPETEER_EXECUTABLE_PATH=$PROOF_CHROME" >> "$GITHUB_ENV"
