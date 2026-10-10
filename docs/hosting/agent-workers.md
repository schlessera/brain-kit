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
the bootstrap are outside this boundary. #1037 and #1038 moved Claude and pi
SDK/extension initialization into these workers. The integrated
adapter/application proof is `tests/policy-write-boundary.test.ts` (#1039);
the [decision record](../decisions/policy-write-boundary.md#the-integrated-proof--1039)
lists its cases. A passing host probe alone still does not establish that proof.
Interactive and voice workers share the host network namespace and see a
read-only host root. Autonomous turns use the restricted envelope below.

## The restricted envelope for autonomous turns (#676)

`runAutonomousTurn` sends every autonomous turn with
`autonomous.containment: "restricted"`, and dispatches only to a backend that
advertises `capabilities.restrictedAutonomous`; both first-party backends do.
A handoff summary is nonpersistent and toolless but not restricted, and is
unchanged. A restricted turn's worker is launched in the launcher's
`restricted` mode.
It adds a network namespace that holds only loopback, so no host interface,
host TCP/UDP listener, resolver or abstract Unix socket is reachable. The host
root is not mounted. The worker sees only `/usr` and the system library and
binary directories, a fixed list of dynamic-linker and name-service files from
`/etc`, the read-only brain, the installed runtime it runs, a fresh tmpfs
`/tmp`, scratch and runtime state. The installed runtime is the executable for
Claude, and for pi the Bun binary, each `node_modules` on the entry's path and
the linked workspace packages in them. The launcher refuses a read path that is
the host root, `/home`, `/etc`, `/run`, `/var`, `/tmp` or an ancestor of the
brain. No host home, stored login or `/run` socket is visible.

The worker's only route out is the server-owned inference relay
(`export function startInferenceRelay(`, `packages/ui-sdk/src/server/inference-relay.ts:60-132`).
It is a Unix socket in a private `0700` directory, bind-mounted read-only at
`/run/brain-inference`. It forwards only `POST` to the provider's inference
routes, such as `/v1/messages` and `/v1/messages/count_tokens` for Anthropic,
to the upstream the profile selects. It removes every inbound credential,
cookie, host and forwarding header, sets the server-held credential, and
refuses redirects and bodies over 32 MiB. The worker holds the placeholder
`brain-inference-relay-placeholder` where its credential would be.

- **Claude** reaches the relay through the CLI's `ANTHROPIC_UNIX_SOCKET`, with
  `ANTHROPIC_BASE_URL=http://localhost`. Flag settings pin both. The environment
  is `PATH`, `LANG`, the pinned route and placeholder, and the non-essential-traffic
  and auto-update switches. Runtime state is an empty tmpfs directory: no stored
  login, settings, account file or transcript enters or leaves it. The turn sets
  `settingSources: []` and `strictMcpConfig: true`. Tool membership stays the
  enforced roster, so an out-of-roster call escalates rather than disappears. A subscription turn needs `CLAUDE_CODE_OAUTH_TOKEN`; a stored
  `claude login` is never copied into the envelope, so such a turn refuses.
- **pi** runs its SDK in process, so its trusted worker entry binds a loopback
  port before pi initializes and forwards it to the relay socket. pi's provider
  points at that port with the placeholder key. No `auth.json`, `models.json` or
  settings file is copied in. The resource loader loads no extension, skill,
  prompt template, theme, context file, `SYSTEM.md` or project setting; the
  inline permission gate remains. The relay supports the `anthropic-messages`,
  `openai-completions` and `openai-responses` provider APIs with an API key from
  `auth.json`, the server environment or a `models.json` override. OAuth logins,
  command-sourced keys and other provider APIs refuse.

Before an autonomous turn, the per-turn probe launches this restricted mode
and checks that only loopback exists and the relay mount is present. A host that
cannot create the network namespace refuses before any worker or inference.

A Unix socket file inside the read envelope stays reachable, because a
read-only mount does not prevent `connect`. The envelope contains only the
brain, system directories and installed packages, so this needs a host process
listening inside one of them.

## Measured host-component matrix

These rows qualify the launcher/probe component. Where a row says so, the
integrated two-adapter proof (#1039) and the autonomous containment proof (#676)
have also passed on that tuple; both drive the installed adapters with loopback
fixture inference. Each automatic proof retains its exact tuple in
`tmp/worker-host-probe.json`, `tmp/policy-boundary-probe.json` or
`tmp/autonomous-containment-probe.json` and the unit-job logs/artifacts. Changing a tuple still requires the actual
per-turn capability check; an OS name alone never admits a turn.

| Host / architecture | Kernel / Bun / bubblewrap | Installed adapters and runtimes | Brain / scratch backing filesystems | Required capabilities and proof |
| --- | --- | --- | --- | --- |
| Linux x86_64, measured 2026-10-10 | `7.2.5-3-omarchy` / `1.4.2` / `0.12.0` | Claude adapter `0.40.0`, Agent SDK `0.3.293`, native Claude Code `2.1.293`; pi adapter `0.40.0`, coding-agent `0.99.2` | Brain Btrfs (`0x9123683e`); isolated scratch tmpfs (`0x01021994`) | Runnable bubblewrap; permitted unprivileged user/mount/PID/IPC/UTS namespaces; fresh proc/dev; `mkfifo`; Linux proc descriptor metadata and Bun execve. Actual probe, hardlink/scratch-alias bytes and membership checks, scratch readback, stdio/descriptor refusals, and active-gate turn regressions passed. The integrated proof `tests/policy-write-boundary.test.ts` (all 14 tests, both adapters) passed on this tuple on 2026-10-10. |
| Ubuntu 24.04 CI x86_64, measured 2026-10-10 | `6.17.0-1022-azure` / `1.4.2` / `0.9.0` | Claude adapter `0.40.0`, Agent SDK `0.3.293`, native Claude Code `2.1.293`; pi adapter `0.40.0`, coding-agent `0.99.2` | Brain ext4 (`0xef53`, confirmed with findmnt); isolated scratch tmpfs (`0x01021994`) | Same capabilities as the Linux row above. All seven real launcher/probe tests and all six refusal/authority gate tests passed in [the automatic unit job](https://github.com/schlessera/brain-kit/actions/runs/38014138934/job/114100926349). The exact tuple is retained in its logs/artifact; this component receipt is distinct from the full PR verdict. The integrated proof `tests/policy-write-boundary.test.ts` (all 14 tests, both adapters) passed on this tuple in [its automatic unit job](https://github.com/schlessera/brain-kit/actions/runs/38053535597/job/114217419653) on 2026-10-10; `tmp/policy-boundary-probe.json` in that job's artifact records the tuple. |
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

For the integrated two-adapter proof, run `bun run test tests/policy-write-boundary.test.ts`.
It needs bubblewrap, unprivileged namespaces and `python3`, and makes no request
beyond the loopback fixture inside its own network namespace.

For the autonomous containment proof, run `bun run test tests/autonomous-containment.test.ts
packages/ui-sdk/tests/inference-relay.test.ts`. It also needs `/usr/bin/python3`,
which the attack runs inside the restricted envelope. Listeners outside the
worker and the server count every connection and datagram, and the fixture
upstream records the credential the relay injected.

The component fixture programs perform only filesystem/stdio operations and make no
network or provider requests. The probe's clear environment and exec boundary
do not propagate a JavaScript test preload into arbitrary future worker code;
the tests prove the named component operations, not runtime or egress containment.
The test harness keeps workspace output ownership with the existing ancestor
instead of transferring its writable lock descriptor into the worker bootstrap.
