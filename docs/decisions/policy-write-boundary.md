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
`packages/ui-backend-claude/src/sdk-options.ts:70-234`); pi builds its worker-local resource
loader and calls `reload()` (`createSessionResources`,
`packages/ui-backend-pi/src/session-resources.ts:27-101`). A child-only wrapper
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

### The integrated proof — #1039

`tests/policy-write-boundary.test.ts` is that proof. Its probe
(`tests/fixtures/policy-boundary-probe.ts`) runs each adapter through
`runSession`, a voice `HostWork` or `runAutonomousTurn` with loopback fixture
inference, inside a network namespace. An outer stage that is neither the server
nor the worker records the policy bytes, the policy directory membership and a
manifest of the whole brain tree before and after the turn. It also sets up the
attack surfaces: policy-backed server stdout, an inherited writable descriptor,
a writable descriptor and shared mapping opened before confinement, a donor
process that holds both, and hardlink, symlink, directory-symlink and outside-brain
aliases.

For both adapters the suite covers:

- **Interactive turns.** The six measured escapes, socket and `/proc`
  descriptor transfer, mappings, `/proc` access to the server and donor, case and
  NFKC aliases, every routed operation and the mask and ask-user bridge effects.
  The writers are Bash, indirect and nested scripts, a Claude subagent, the pi
  extension tool and the brain CLI. Each runs beside a permitted `edit_file`
  that reaches Markdown in the same turn.
- **Route races.** Directory, hardlink, symlink and policy-ancestor swaps between
  the route's validation and commit, made through its deterministic
  `beforeCommit` seam.
- **Voice.** Claude's narrower membership cannot grant, raw writes are outside
  it, and a capture still lands. pi refuses voice turns before any worker starts.
- **Autonomous turns.** Bash and the raw write tool are explicitly allowed, but
  their writes stay in scratch. The autonomous bridge has no application route,
  so R31 is held by the absence of any authoritative change, not by a paired
  edit. Since #676 these turns run in the restricted envelope and load no
  project hook, MCP server or extension, so the suite asserts that none of the
  pre-tool executors starts.
- **Refusal.** With a failing host probe, interactive, voice and autonomous turns
  are refused before any inference request, process spawn or pre-tool executor.

Its recorded mutations are a writable brain bind with a blind probe, which fails
the policy-bytes assertion for both adapters; a removed route topology recheck,
which fails the race case; and a skipped host gate, which fails the refusal cases.
It runs in the CI unit job and has passed on both rows of the
[measured matrix](../hosting/agent-workers.md#measured-host-component-matrix).
It proves the filesystem boundary only.

#676 separately owns complete R28/R29/R31 credentials, ambient-configuration and
egress containment for both runtimes. The filesystem experiment, these rulings,
the integrated proof and a green tool-membership test do not discharge that
obligation. Interactive and voice workers still share the host network
namespace, so a host process that hands out descriptors over a reachable Unix
socket is not a case this suite closes. The restricted envelope for autonomous
turns and its proof are recorded in
[the async collaboration decision](async-collaboration.md#autonomous-containment--2026-10-10).
Autonomous enablement still requires the complete system proof. #674 must
assess its implementation's machine-contract and version impact separately;
this decision changes documentation only.

## Curated operations use server-owned tools — 2026-10-05

The [maintainer ruling](https://github.com/schlessera/brain-kit/issues/674#issuecomment-5999043045)
selects server-routed structured tools for hosted curated writes in both adapters.
Capture, update and archive complete in one validated step with existing approvals,
locking, indexing and current-principal authorization. Hosted Claude turns shadow
project `brain` MCP write tools. Terminal MCP clients keep their names and schemas.
Core skills name the hosted tools while retaining terminal CLI instructions.

CLI writes through a read-only worker fail visibly with a read-only diagnostic
and curated-tool guidance; no command is staged or replayed. New hosted tool names
and schemas are an additive contract change with a minor changeset. Bubblewrap
0.9 remains eligible; writable overlays and copied scratch brains are declined.
The three October 2 rulings, R31, R33, R35 and voice membership are unchanged.

The five implementation children of #51 separately own host setup, this application
route, each runtime worker, and integrated escape proof. The route does not claim
worker containment or enable unattended authoritative writes. Current principal
and exact operation membership are checked again at application time. Supported
applications are bounded UTF-8 Markdown effects plus the narrow PNG mask
operation below, never commands or file handles.

## PNG mask application — 2026-10-10

The [maintainer ruling on #1037](https://github.com/schlessera/brain-kit/issues/1037)
preserves hosted masking through one server-owned binary operation. It accepts
only a PNG mask for a submitted existing image, at the existing adapter filename,
selected by trusted server backend identity, with an 8 MiB byte cap and PNG signature check. Exact browser submission, current
turn authority/membership, cancellation, image/mask bases, policy/alias/path and
topology checks bound the effect. Scratch masks retain their existing prerequisites;
pruning runs under the same authority and records actual removals. The bridge tool
and browser/model result shape remain unchanged. This is an additive contract
change; it supplies no generic binary route or autonomous authority.

Claude uses the structured server write/edit tools rather than translating native
built-in callbacks. This preserves exact-base validation and server-side permission
checks without performing a privileged effect inside a hook that the runtime can
later deny. Unsupported notebooks refuse. The CLI, tools, subagents and project
stdio MCP descendants enter the mandatory worker; only trusted bridge handlers and
bounded native transcript persistence remain in the parent. #1039 owns the wider
integrated escape matrix; #676's credential, configuration and egress proof is
[recorded separately](async-collaboration.md#autonomous-containment--2026-10-10).
