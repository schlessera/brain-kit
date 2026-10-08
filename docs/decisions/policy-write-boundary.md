# Decision — isolated agent writers and validated authoritative edits

The maintainer's three 2026-10-02 rulings on
[#674](https://github.com/schlessera/brain-kit/issues/674) select:

1. [Isolated workers and server-validated edits](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943637433).
2. [Existing approvals for permitted edits](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943943836).
3. [Linux-first hosting, with qualifying WSL2 profiles](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5944340342).

These choices bind implementation. They do not establish production containment,
enable autonomous execution or make a release commitment. The
[finite investigation](../plans/policy-write-boundary.md) remains evidence about
its measured fixture. The [async collaboration decision](async-collaboration.md)
and [voice decision](voice-permission.md#containment-shared-with-51-deliberately-not-identical)
continue to bind authority and tool membership.

## Every writer enters through the boundary

Both first-party runtimes run in isolated workers, confined **before** SDK,
extension, custom-tool or other agent writer initialization. This includes pi
extension factories and Claude runtime-owned executors, rather than only their
shell children. Each worker receives a read-only authoritative brain view and
separate writable scratch. The boundary covers ordinary interactive, voice and
autonomous turns, including indirect scripts and nested execution.

Ordinary shell and custom-extension writes therefore no longer directly change
authoritative brain files. Their output stays in scratch or staging until an
explicit bounded application request names the files and exact proposed changes.
The privileged server never replays a worker's command. Workers receive neither
arbitrary privileged filesystem handles nor a generic privileged shell route.

Use the existing server lifecycle and AgentBackend interface for worker ownership,
communication and teardown. This choice adds no daemon or extension seam.
Cancellation and session history must remain accurate across worker execution,
application, refusal and recovery.

This is a change to the execution architecture. Current Claude assembly creates
SDK options and in-process bridge tools (`createClaudeSdkTurn`,
`packages/ui-backend-claude/src/sdk-options.ts:55-221`); pi builds its resource
loader and calls `reload()` (`createSessionResources`,
`packages/ui-backend-pi/src/session-resources.ts:27-95`). A child-only wrapper
cannot be treated as proof for those parent-side paths. The investigation records
the concrete unsandboxed extension-initialization escape.

## Application preserves existing authority

Otherwise permitted ordinary interactive document/file edits may complete during
the turn without an additional confirmation for every edit. Curated brain
operations retain their existing permissions. An explicit shell/extension
application request is a bounded proposal, not authority supplied by the worker.
The server validates every application against:

- The exact operation, input and target, and the principal's **current** authority.
- Policy-path, ancestor and alias denial; bounded payloads and explicitly supported
  operations and file kinds.
- Filesystem topology races and stale or conflicting content. Unsupported effects
  and conflicts visibly refuse, without overwriting concurrent edits or silently
  merging them.
- Existing locking, indexing, cancellation and accurate history, including which
  changes actually reached the authoritative Markdown.

Destructive effects retain their existing explicit permissions. A successful
scratch write, an allowed tool name or a prior application cannot authorize a
different effect. The server-owned validation/application path must be covered
by the boundary proof, including privileged bridge effects.

R35 denies policy writes to **every** agent runtime, including ordinary shells,
extensions and autonomous agents. R33's v1 no-policy-read rule remains binding:
policy content cannot supply authority; policy formation and activation stay
deferred. This record grants no new policy access or standing permission.

Voice and unattended execution retain **one tool-enforcement mechanism with
different named memberships**. The filesystem boundary applies to both and to
ordinary turns. Voice keeps its narrower membership, including raw-write
exclusions; speech may refuse and can never grant. Authorized curated capture
and update operations remain possible under their existing rules.

R31 unattended share triage remains confined to scratch/staging. Authoritative
autonomous effects still require existing explicit bounded authorization for
the exact operation. Neither triage nor the isolated-worker choice authorizes
acting on arbitrary shared content.

## Supported-host matrix and visible refusal

Initial support is limited to **explicitly verified Linux profiles**, starting
with the namespace/bubblewrap candidate. WSL2 is eligible only when the required
capabilities actually work and the same integrated proof passes. Native macOS
and native Windows backend hosting are deferred to separate measured work.
The browser client's operating system is independent of backend-host support.

The matrix below states eligibility and proof obligations, not a list of proven
production profiles. Implementation must publish exact architecture, runtime
versions, backing filesystem and capability tuples and prove each supported row.
An OS label or successful version check alone is insufficient.

| Backend host | Architecture and runtime versions | Backing filesystem | Required capabilities and disposition |
| --- | --- | --- | --- |
| Linux | Exact architecture, kernel, Bun, sandbox launcher and installed Claude/pi adapter/runtime versions measured together | Exact authoritative and scratch filesystems, including alias and topology behavior | Establish the pre-initialization namespace/bubblewrap boundary, read-only brain, separate writable scratch and closed inherited authority; pass both adapters' integrated proof before declaring support. |
| WSL2 | Exact WSL2 kernel/architecture and the same runtime dimensions as Linux | Exact brain/scratch locations and filesystem behavior; WSL2 presence is insufficient | Meet the same actual capability and integrated-proof requirements as Linux; otherwise visibly refuse. |
| Native macOS / Windows | No supported tuple selected by this ruling | No backing filesystem qualified by this ruling | Backend hosting deferred; visibly refuse rather than use a weaker profile. |
| Any unlisted or failed profile | Unknown or unverified tuple | Unknown or unverified behavior | Refuse before writer initialization; do not infer support from a similar measured row. |

Before **each** interactive, voice or autonomous turn initializes any agent
writer, verify that the required boundary can actually be established. An
unsupported profile or failed capability/confinement check must visibly refuse,
name the missing requirement and give a supported-host route. There is no weaker
profile or automatic unsandboxed fallback. Version compatibility and historical
measurement do not substitute for this check.

The investigation's historical tuple was Linux x86_64 on WSL2 kernel
`6.18.33.2-microsoft-standard-WSL2`, Bun `1.3.14`, Python `3.12.3`, bubblewrap
`0.9.0`, Landlock ABI `7`, pi coding-agent `0.99.2` and Claude Agent SDK
`0.3.283`, measured on 2026-10-01. That finite fixture is **not** a supported
production matrix row: the Claude spawn adapter ran a fixture program rather
than a vendor model turn, and authoritative application was absent.

## Why these alternatives lost

The [architecture comparison](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943238069)
considered retaining direct authoritative writes through a separately privileged
worker identity and protected inode/ancestor ownership. It would require a new
concrete privilege and filesystem layout with proof for aliases, rename,
descriptors and bridge effects. The finite investigation supplied no such
proof. The maintainer accepted the changed shell/extension behavior of read-only
workers with validated effects instead. Neither choice is proven by its approval.

The [editing comparison](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943640675)
considered mandatory review for every staged edit. The maintainer selected
existing approval rules so otherwise authorized interactive edits can finish
in their turn without an extra confirmation. Exact validation, conflict refusal
and destructive permissions remain mandatory; the choice removes no guard.

The [host comparison](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5943978912)
considered broader initial platform support. Linux-first delivery avoids treating
unmeasured native macOS/Windows designs as equivalent containment. WSL2 must
qualify on capabilities and proof rather than its name.

## Evidence the implementation still owes

#674 owns production integration and the all-writer proof. Exercise both
installed adapters through their actual ordinary-turn entry points, using a
keyless fixture inference transport. Observe nonempty original policy bytes and
directory membership from outside the boundary, alongside successful unrelated
permitted authoritative edits through the selected application route.

Retain the investigation's weaker-profile escapes: writable hardlink aliases,
host scratch aliases, inherited writable descriptors, policy-backed stdio,
parent-side extension initialization and confinement applied after an open.
Add mappings, descriptor/socket transfer, `/proc`/parent access, topology races,
extension startup before tool events and privileged bridge effects. Mutate the
integrated enforcement, observe the intended write-safety assertion fail, then
restore it. Prove unsupported-profile refusal occurs before initialization.

#676 separately owns complete R28/R29/R31 credentials, ambient-configuration and
egress containment for both runtimes. The filesystem experiment, these rulings
and a green tool-membership test do not discharge that obligation. Autonomous
enablement still requires the complete containment and system proofs. #674 must
assess its implementation's machine-contract and version impact separately;
this decision changes documentation only.
