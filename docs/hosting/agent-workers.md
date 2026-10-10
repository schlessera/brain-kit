# Agent worker host boundary

The [all-writer decision](../decisions/policy-write-boundary.md) requires a
read-only authoritative brain and isolated writable scratch before an agent
writer initializes. The shared TypeScript launcher and per-turn host probe are
the host-side implementation of that decision (#1035).

The server checks the actual configured brain before each interactive, voice,
queued, autonomous and handoff-summary turn. A failed check refuses before
`startTurn`, session/transcript writes or activity-runtime creation. Its visible
message names the missing requirement and the Linux/qualifying WSL2 route;
ordinary error frames carry `failure.errorClass = worker_host_unsupported`.
There is no flag, environment override, weaker profile or unsandboxed fallback.
Standalone autonomous callers default their brain path to the working directory;
hosts with another brain must supply `brainPath`.

The probe uses the real launcher, a disposable nonempty sentinel on the
configured brain filesystem and a nonempty scratch write/read control. It
observes the sentinel from the host, bounds launch execution to five seconds,
and removes its sentinel directory on either outcome. The host must be able to
create and remove that owned fixture. Checks are repeated, not cached from a
version string or an earlier turn.

## Process and filesystem coverage

`launchAgentWorker` (first-party internal SDK sharing) starts a trusted bootstrap
with three owned FIFO channels. Bun 1.4.2's `"pipe"` channels are Unix sockets,
so the launcher uses `mkfifo`, opens the two ends, and unlinks the private FIFO
paths before launch. The bootstrap validates actual pipe descriptors 0–2 and
refuses unexpected inheritable descriptors. It explicitly closes descriptors
above 2 before `process.execve`; runtime CLOEXEC descriptors are discarded at
exec too. Bun's read-only `/dev/urandom` descriptor is explicitly closed. A
refusal reports only on a validated pipe, so policy-backed stderr cannot be
modified even by the diagnostic itself.

Bubblewrap establishes user, PID, IPC, UTS and mount namespaces, drops all
capabilities, mounts `/` and the canonical brain read-only, and replaces `/proc`
and `/dev`. `/tmp` is private tmpfs; the scratch location is a fresh tmpfs,
never a writable host bind. Scratch cannot overlap the brain or its ancestors.
The worker receives only explicit environment entries and
`BRAIN_WORKER_SCRATCH`. There is no overlay dependency; bubblewrap 0.9 is eligible.
The worker and its descendants are inside the boundary. PID-namespace ownership,
`--die-with-parent` and the returned process handle support cancellation.
The caller owns the returned stdin/stdout/stderr streams and closes or destroys
them when cancelling a worker.

The privileged server, its validated application route and code loaded before
the bootstrap are outside this boundary. Moving Claude and pi SDK/extension
initialization into these workers belongs to #1037/#1038, with integrated
adapter/application proof in #1039. A passing host probe does not establish
that those integrations have shipped. #676 separately owns credentials,
ambient configuration, network/Unix-socket egress and full autonomous containment.
This launcher shares the host network namespace and exposes a read-only host
root; it is not that complete containment profile.

## Measured host-component matrix

These rows qualify the launcher/probe component, not completed adapter
containment. Adapter versions identify the installed context; the launcher
fixtures use filesystem writers without model calls or SDK initialization.
Each automatic proof retains its exact tuple in `tmp/worker-host-probe.json`
and the unit-job logs/artifacts. Changing a tuple still requires the actual
per-turn capability check; an OS name alone never admits a turn.

| Host / architecture | Kernel / Bun / bubblewrap | Installed adapters and runtimes | Brain / scratch backing filesystems | Required capabilities and proof |
| --- | --- | --- | --- | --- |
| Linux x86_64, measured 2026-10-10 | `7.2.5-3-omarchy` / `1.4.2` / `0.12.0` | Claude adapter `0.40.0`, Agent SDK `0.3.293`, native Claude Code `2.1.293`; pi adapter `0.40.0`, coding-agent `0.99.2` | Brain Btrfs (`0x9123683e`); isolated scratch tmpfs (`0x01021994`) | Runnable bubblewrap; permitted unprivileged user/mount/PID/IPC/UTS namespaces; fresh proc/dev; `mkfifo`; Linux proc descriptor metadata and Bun execve. Actual probe, hardlink/scratch-alias bytes and membership checks, scratch readback, stdio/descriptor refusals, and active-gate turn regressions passed. |
| Ubuntu 24.04 CI x86_64, measured 2026-10-10 | `6.17.0-1022-azure` / `1.4.2` / `0.9.0` | Claude adapter `0.40.0`, Agent SDK `0.3.293`, native Claude Code `2.1.293`; pi adapter `0.40.0`, coding-agent `0.99.2` | Brain ext4 (`0xef53`, confirmed with findmnt); isolated scratch tmpfs (`0x01021994`) | Same capabilities as the Linux row above. All seven real launcher/probe tests and all six refusal/authority gate tests passed in [the automatic unit job](https://github.com/schlessera/brain-kit/actions/runs/38014138934/job/114100926349). The exact tuple is retained in its logs/artifact; this component receipt is distinct from the full PR verdict. |
| Native macOS / Windows | No qualified tuple | No qualified runtime pair | No qualified backing filesystems | Refused before writer initialization: required Linux namespaces unavailable. |

No new WSL2 tuple has passed this implementation's checks. WSL2 may qualify
only through the same actual launcher/probe and integrated adapter proof; the
investigation's historical WSL2 measurement is not a supported row.

The browser client's operating system is independent of this backend-host rule.

## Reproducing the component proof

After the frozen dependency install, run:

```sh
bun run test packages/ui-sdk/tests/worker-launcher.test.ts \
  packages/ui-server/tests/worker-host-gate.test.ts \
  packages/ui-server/tests/run-session.test.ts \
  packages/ui-server/tests/autonomous-turn.test.ts \
  packages/ui-server/tests/ws-handoff.test.ts
```

These fixture programs perform only filesystem/stdio operations and make no
network or provider requests. The probe's clear environment and exec boundary
do not propagate a JavaScript test preload into arbitrary future worker code;
the tests prove the named component operations, not runtime or egress containment.
The test harness keeps workspace output ownership with the existing ancestor
instead of transferring its writable lock descriptor into the worker bootstrap.
