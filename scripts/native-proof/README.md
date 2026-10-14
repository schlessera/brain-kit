# Offline native hosted regression

`bun scripts/prove-native-host.ts` runs the real app, Unix native manager and
both Claude and Pi workers sequentially against a separately owned 4 GiB Btrfs
loop filesystem, as both UID 1000 and UID 0. Each run must complete cleanup
before the next begins. Use `--backend=claude` or `--backend=pi`, and optionally
`--app-uid=0` or `--app-uid=1000`, for a focused run.
Run `bash scripts/ci-runtime-setup.sh --native` to prepare the image and kernel
prerequisites. Preparation can download dependencies; the proof uses
`--network=none`, `--pull=never`, the normal test network guards and loopback
HTTP/WebSocket clients. Missing prerequisites fail the selected runtime job.

Claude substitutes only its query transport; Pi uses its actual SDK session and
Bash tool through a keyless loopback Anthropic SSE transport. Neither replaces
the worker, native storage, journal or admission path. The proof checks real
first/warm writes, Stop, admission cancellation, reconnect and owned cleanup.
A fixed Python witness executes inside actual agent and automatic index
maintenance workers: capabilities are zero, `no_new_privs` holds, all seven
Btrfs mutation ioctls and trusted OverlayFS markers are denied, and native
manager state/socket paths are masked. UID-0 workers also prove `/proc` is
read-only; the root app must emit its existing boot and status warning.

The fixture refuses an existing loop1790, creates an exclusive fully allocated
backing, and verifies its device/inode/minor before format and cleanup. Its
bounded filesystem preserves the existing 2 GiB free-space floor. The Docker
supervisor has only the listed capabilities needed to own the fixture and
native manager. UID-1000 apps have no capabilities. UID-0 runs additionally
grant the fixture supervisor `SETFCAP`, required by Linux 5.12 and later to
map parent UID 0 into a new user namespace; untrusted workers still have zero
capabilities. This is fixture setup, not a production permission change.
The operator-owned artifact directory permits UID-0 workers to traverse it
without DAC override. Source and Bun mounts are read-only. Receipts include
app phases, worker authority, native operations and
exact owned-resource cleanup under `tmp/native-host-proof/`.

`seccomp.json` derives from Moby's Apache-2.0 profile at the revision recorded in
`seccomp-source.json`; `LICENSE.seccomp` preserves its license. The derivation
adds the namespace calls needed by the real worker harness and removes the
existing explicit `clone3` errno rule so that the added allowance applies.
The default-deny action and every other upstream rule remain unchanged.
`systempaths=unconfined` permits a new procfs in the worker's namespace; it does
not disable seccomp. These fixture controls follow the namespace requirements
documented in `docs/hosting/agent-workers.md`.

When Docker reports AppArmor support, runtime setup must load the separately
named `brain-kit-native-proof` profile; loading or using it unsuccessfully fails
the proof. `apparmor-source.json` pins its Moby template. Its only policy changes
permit mounts and `pivot_root`; all other upstream restrictions remain. It does
not replace the daemon default. The same Moby license applies. A host without
AppArmor records that absence explicitly and provides no enforced AppArmor
qualification.
