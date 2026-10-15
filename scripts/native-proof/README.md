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

Claude uses its actual backend adapter and production worker launcher with a
deterministic SDK-query fixture that launches a scripted shell and emits SDK
messages; this native check does not execute the Claude CLI or its HTTP transport.
Pi uses its actual SDK session and Bash tool through keyless loopback Anthropic
SSE. Both retain the real app admission, worker, native storage and journal.
The separate offline Claude CLI measurements exercise real HTTP and tool behavior
with explicit copied fixture inputs; they do not qualify native Btrfs storage. The proof checks real
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
The operator-owned artifact directory permits both fixed app UIDs to traverse it
without DAC override. Source and Bun mounts are read-only. Receipts include
app phases, worker authority, native operations and
exact owned-resource cleanup under `tmp/native-host-proof/`.

The hosted runtime job also records a root-only btrfs kernel trace around the
proof (`dead-root-trace.sh start <file>` / `stop`). Btrfs queues a deleted
checkpoint for its cleaner only when the last in-memory reference goes away.
If that happens after `subvolume delete --commit-after` has woken the cleaner,
reclamation waits for the next commit-interval pass, about 30 s later. A
reference that outlives the delete by even 1 ms therefore exhausts the
manager's release deadline. `dead-root-trace.ts` matches each delete to its
root and writes `dead-root-summary.json`, which records whether the delete
itself queued the root or another task did, before or after the commit, with
that task's kernel stack. The deliberate descriptor, cwd and namespace
controls appear as `after-commit`. The trace is diagnostic evidence, not a
proof gate. Locally it needs root, tracefs, kprobes and kernel BTF.

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
the proof. `apparmor-source.json` pins its Moby template. Its policy changes permit mounts and `pivot_root`, and exempt exactly
`/proc/sys/user/max_user_namespaces` from the non-kernel sysctl write deny.
Bubblewrap writes the first private user namespace's quota before entering its
second namespace to enforce maintenance's existing `--disable-userns` and
`--assert-userns-disabled` flags. Every other previously denied sysctl path,
including shorter prefixes, siblings and suffixes, remains denied. The
capabilities-zero maintenance payload must fail both a quota write-open and a
further user namespace creation. Runner and outer-container quota values must
remain unchanged; the proof never writes either parent quota. These restrictions
apply to maintenance; agent-turn capabilities remain unchanged.

Native qualification requires healthy boot maintenance, first/warm session and
journal profiles actually reported as `governed`, indexed worker notes after
clean shutdown, and all authority and cleanup assertions. Strict fallback is
not a passing governed qualification. It does
not replace the daemon default. The same Moby license applies. A host without
AppArmor records that absence explicitly and provides no enforced AppArmor
qualification.

## Event observation

The child app appends JSONL events; the newline commits a record for proof
observers. A concurrent filesystem read can return an exact prefix ending
inside the writer's valid JSON. Live observers validate every complete record
and withhold the unterminated tail, including a valid JSON object whose newline
has not arrived. They never trim or parse that tail as a committed event.
After child exit, any remaining tail fails the proof. Malformed complete JSON,
invalid UTF-8 and records without an object/string kind fail immediately.
All live event counts and matching predicates share this rule. Final provider-entry
and whole-brain-scan counts are checked again after shutdown, so a pending live
tail cannot hide a forbidden event that commits later.

The first pending observation is retained as `event-observation-pending.bin`
and `.json`; the first malformed complete or incomplete final evidence is retained as
`event-observation-failure.bin` and `.json`. These are exact read snapshots,
separate from the later shutdown `events.jsonl`. Metadata records phase,
live/final state, reader PID, byte boundaries, snapshot SHA-256 and file identity,
size and modification time before/after the read. Pending captures are bounded
to the first observation per fixture; an error capture remains mandatory and
shutdown cannot overwrite the first failing read.
These artifacts diagnose observations; they do not establish successful native
admission, cancellation, refresh or cleanup on their own.

`bun run test tests/native-event-log.test.ts` covers framing, a real child
append barrier, exact retained evidence, malformed complete records and strict
shutdown. The full native runtime still supplies the backend/UID qualification.

## Native release observations

When a checkpoint's real `btrfs subvolume sync` exits unsuccessfully, the
fixture retains `run/native-release/<checkpoint-id>.json` beside its native
operation log. The observer records the pre-delete root identity, command
exit, termination signal and synchronous abort context when available. Bun
can omit caller frames across native abort callbacks; an absent frame does
not identify or exclude a cancellation source.

Samples at 1, 5 and 15 seconds, plus failure completion, inspect only the
isolated fixture container's `/proc`. They report matching checkpoint paths
or device identities in open descriptors and cwd/root references, matching
mount rows, a bounded cwd/root/process census, mount-namespace descriptors,
sync process state and observation errors. Limits are 256 processes, 256 descriptors per
process, 64 references, 64 mount-namespace descriptors and 16 mount groups per sample;
truncation is explicit, including truncated error samples.
Path matching can miss references renamed or aliased in another namespace,
and device metadata can be unavailable after deletion. Missing references
therefore do not prove that no reader remains. Successful sync commands leave
no diagnostic file. The observer preserves command arguments, signals and
existing transport deadlines and restores its wrapped globals after the test.

The Pi UID-0 cell holds both a real checkpoint file descriptor and, in a
separate case, a child process cwd through the
unchanged 30-second client deadline. It verifies the unknown release outcome,
recorded connection abort and killed sync, and observation of that exact
reader. Closing the reader must allow the same checkpoint identity to reconcile
to deleted. This control demonstrates a retained-reader failure class; it does
not establish the cause of the historical automatic-index failure in #1967.
All four original backend/UID admission and automatic-index checks still run.

The Pi UID-0 automatic index also starts a marked detached descendant inside
its actual maintenance worker. The child uses the immutable configuration
view as cwd and remains in that worker's PID namespace. A bounded 50 ms host
witness records up to 16 identities (PID plus kernel start time), their cwd,
mount namespace, ancestry and observed death. The normal case requires two
actual descendants to have exited before queued refresh completion. This is
sampled evidence for these marked children, not an exhaustive process trace.

A separate, explicit fault-injection command reproduces the automatic-index
release failure while preserving the original completion guard:

```sh
bun scripts/prove-native-host.ts --backend=pi --app-uid=0 --retain-index-namespace
```

**Expected exit: 1.** This is an intentionally failing reproduction, not a
healthy native qualification. The fixed offline fixture opens a handle to the
first witnessed index worker's mount namespace, retaining its mounts after
its processes exit. The unchanged client deadline interrupts checkpoint sync,
records unknown outcome and `automatic_index_failed`, and the original
`NATIVE_AUTOMATIC_INDEX_COMPLETED` assertion fails. The fixture closes that
exact namespace handle when the real sync exits unsuccessfully; same-identity
recovery and owned outer cleanup remain in force. A failure for a different
reason does not reproduce this case. The descriptor and cwd controls still run.
The flag requires explicit Pi UID 0 and never applies to the default matrix.

Inspect `run/index-descendant-lifetime.json` for the witnessed namespace and
its retained descriptor/close time, then correlate it with the failing root's
`run/native-release/<checkpoint-id>.json`, native operations and ordinal-1
failure event. The descriptor's `mnt:[...]` identity must match the witnessed
worker namespace after the marked child exits. Root-path descriptor/cwd and
mount lists can all be empty while that namespace handle retains the mounts.
The observer reports such namespace handles separately; they are not asserted
to reference a particular checkpoint without that correlation. Linux documents
this lifetime in [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html).

This constructed full-index failure distinguishes process exit from namespace
lifetime. It does not establish that the historical #1967 run retained a
namespace handle, and selects no production correction or deadline change.

The full command without selectors first qualifies all four healthy cells,
then runs this separate negative control. It returns success only when the
negative control fails on the exact original assertion and its complete
artifacts prove the retained namespace outlived the child, the matching handle
closed, the same root subsequently synchronized, ordinal 1 stayed failed,
ordinal 2 completed, and owned cleanup and both quota checks passed. A missing
prerequisite, unrelated failure, absent observation or unexpected passing index
fails that verification. `index-release-reproduction.json` records this as an
expected failure with `qualification: false`; it does not turn the failing
invocation into a healthy fifth matrix cell. The selected hosted runtime job
therefore exercises the reproduction under its enforced AppArmor profile too.
