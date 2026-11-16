#!/bin/sh
# Run from an exclusively owned checkout, before editing installed dependencies.
set -eu
if [ -e node_modules ] || [ -L node_modules ]; then
  echo 'Diagnostic install refused: preserve evidence and move aside the owned node_modules first; see CONTRIBUTING.md.' >&2
  exit 1
fi
umask 022
diagnostic_cache=$(mktemp -d)
trap 'rm -rf "$diagnostic_cache"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
BUN_INSTALL_CACHE_DIR="$diagnostic_cache" bun install --force --frozen-lockfile --backend=copyfile --cache-dir "$diagnostic_cache"
