# Preparing dependency diagnostics

Before editing anything under `node_modules`, use an exclusively owned checkout
with no build, test or editor process using its dependencies. A separate git
worktree alone does not isolate dependency inodes: Bun's default hardlink
backend can link installations to the same cache file. A diagnostic write then
changes the cache and other installations.

From that checkout, preserve failed receipts, installed-byte hashes and inode
identities before moving its `node_modules` aside to an owned evidence directory
outside the checkout. Do not move another worker's dependencies. Then run:

```sh
sh scripts/prepare-diagnostic-install.sh
```

The command refuses an existing `node_modules`, sets umask `022` in its own
process, creates an empty private cache, and installs the unchanged lock with
`--force --frozen-lockfile --backend=copyfile`. Both `BUN_INSTALL_CACHE_DIR` and
`--cache-dir` select that cache: an inherited environment setting can otherwise
override the flag. It removes only its own temporary cache on success or failure.
An interrupted/failed install may leave partial `node_modules`; preserve its
failure, move aside that owned partial installation and prepare again. Do not
run diagnostics against a failed install.

Preparation is allowed to fetch packages; subsequent tests still run through
the repository's offline entry points. Never add `--no-verify`. A fresh cache
avoids reusing modified cached bytes, and Bun verifies downloaded registry
archives against lockfile integrity. This does not authenticate local/path/git
dependencies or a custom registry without trusted integrity metadata. Check a
suspected registry package's archive against its locked integrity, then compare
the extracted files with installed bytes. An unchanged lockfile or a single-link
copy alone proves neither provenance nor pristine package bytes.

Keep the original and recovered observations separate. Do not change package
versions, locks, assertions, qualification pins or file modes to force a pass.
Rebuild as required and rerun the original focused check through its offline
wrapper. For the frozen native diagram fixture, retain the failed/restored
installation identities and run `bun run test ./tests/native-diagram-inputs.test.ts`.
Once evidence is retained and no process uses it, remove only the owned old
installation. Never delete or repair shared caches while others may use them.
Repeat preparation before a new independent diagnostic; an installation you
have instrumented is no longer pristine.

## Evidence and its limits

[#1980](https://github.com/schlessera/brain-kit/issues/1980) preserves the
observed Vitest 4.1.11 comparison: the instrumented chunk and shared-cache chunk
had identical device/inode identity and 63 links. The modified chunk's SHA-256
was `6b1a505f3953877013957189d5714f77298c40392f19145ab001b6f9dbb76f0c`;
the registry/private-install chunk's was
`a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e`.
The npm archive's declared SHA-512 integrity was independently verified. The
403-byte difference was `REPRO1973` session tracing. Later owned-install
recoveries reproduced the clean qualified installation without changing pins.
These observations establish cache modification and recovery, not its original
author, a product defect, or retrospective cleanliness/failure causation for
historical runs whose installed bytes were not captured.

`tests/diagnostic-install.test.ts` runs a bounded actual Bun install fixture in
a network namespace with only a loopback registry. It demonstrates unsafe
cross-hardlink writes, wrong-byte single-link copies, independent preparation
from a deliberately modified source cache, unchanged package/lock inputs,
archive rejection, refusal to overwrite evidence and owned cache cleanup.
Its fictional package does not requalify historical Vitest or browser runs.
