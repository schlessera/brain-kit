---
name: external-compute
description: Use when a command should run on an external compute provider instead of this machine — it needs isolation from the brain, more CPU or memory than is here, or a clean disposable machine — or when the user asks to run, check, cancel or collect a `brain compute` job or a `brain_compute_*` tool call. Not for ordinary shell commands, which stay local.
compatibility: Requires the brain CLI (`brain compute`) or the brain MCP server (`brain_compute_*`), and a `compute.providers` instance in brain.config. Without one every operation except health refuses with compute_disabled.
---

# External compute — run a bounded job on a configured provider

**This skill decides; `brain compute` executes.** Admission, leases, cost, cleanup and
recovery are the CLI's and the MCP server's. Never reimplement them, never call a vendor
API or CLI directly, and never ask for or handle a provider key.

| Step | CLI | MCP tool |
| --- | --- | --- |
| What is configured | `brain compute health --json` | `brain_compute_health` |
| What a job would do | `brain compute plan --provider ID [...] -- CMD` | `brain_compute_plan` |
| Start it | `brain compute run --provider ID [...] -- CMD` | `brain_compute_run` |
| Follow it | `brain compute status JOB` | `brain_compute_status` |
| Stop it | `brain compute cancel JOB` | `brain_compute_cancel` |
| Its output | `brain compute collect JOB` | `brain_compute_collect` |

## 1. Decide whether it should leave this machine at all

Run locally unless there is a reason not to. A provider costs money, uploads data and
takes minutes to start; a test, a build or a script that fits here belongs here. Use a
provider only when the job needs:

- **isolation**: untrusted code, a dependency install you do not want on this machine, or a
  clean environment to reproduce something;
- **overflow**: more CPU, memory or time than this machine can give without blocking the
  user.

If neither applies, say so and run it locally. Nothing is ever redirected automatically.

## 2. Pick the instance and check it

Run health. Name an instance explicitly: there is no default, and you never pick one the
user has not configured. An instance that is `provider_unavailable` stays unavailable;
tell the user why (`reason`) instead of trying another one silently.

Then plan the exact job. Show the user the source files, the lease and the estimate before
running anything that is not obviously cheap. An estimate of `null` means the cost is
**unknown**, not free: say "unknown", never "$0".

## 3. Declare as little as possible

- **Source**: list only the files the command needs (`--source`, repeatable). Nothing else
  is uploaded, and the brain is never sent implicitly. Every file listed leaves this
  machine and goes to the provider; health notes, private correspondence and anything the
  governance policy routes elsewhere should not be listed. The policy refuses what it
  forbids; do not try to route around a `policy_denied`.
- **Environment**: `--env NAME=VALUE` is for non-secret settings only. Never put a key,
  token or password in argv or env. Values are recorded in the job and the provider keeps
  its own command history: Boat documents keeping command history, including allowlisted
  environment values, for 90 days. Credential-shaped names are refused; a secret under an
  innocent name is not caught, so do not try.
- **Artifacts**: name the files to fetch back (`--artifact path[:maxBytes]`). Collected
  artifacts land in the host's compute state directory with their sha256; they are not
  brain content until you file them through the normal capture path.
- **Lease**: ask for the shortest lease the work needs (`--lease`). The job ends when it
  runs out.

## 4. Run, then always finish

As an agent, start a job with `brain compute run --detach` from your tool shell, or with
`brain_compute_run`. Both return the job id once the command has started. Then follow it with
`brain compute status JOB` (or `brain_compute_status`) at a sensible interval, never in a
tight loop, and end it with collect or cancel. Do not run an attached `brain compute run`
from a tool shell: it blocks until the job ends, and if the tool call times out or is
killed the job is left running. The attached form, where Ctrl-C cancels the job, is for
a person at a terminal.

Every job you start ends with either collect (it finished) or cancel (you no longer need
it). Report to the user the final `state`, the `exit`, the `cleanup` fact and the cost:

- `cleanup` `released` or `retained` is done; `release_failed` or `unknown` means a
  sandbox may still be running and costing money. Say so plainly and suggest
  `brain compute reconcile`.
- `uncertain` means an effect may have happened without a recorded outcome. Do not start
  the job again; the lease bounds it. `brain compute abandon JOB --confirm` is the
  operator's decision, never yours.

Job ids belong to the surface and user that started them: a job started through the MCP
tools is not visible to `brain compute status` in a shell, and the reverse. Ask for status
or cost only when you need it for your next step.
