# Policy-write boundary investigation

R35 requires every agent runtime, including ordinary interactive turns, to be
unable to write `context/policies/**`. V1 also reads no policies for authority
(R33). This investigation for [#672](https://github.com/schlessera/brain-kit/issues/672)
preserves [the full autonomous scope](../decisions/async-collaboration.md) and
[the voice rule](../decisions/voice-permission.md#containment-shared-with-51-deliberately-not-identical):
one tool-enforcement mechanism with different named voice/unattended memberships.

**Result:** no measured boundary meets R35 in the current server/adapter
architecture while retaining ordinary direct brain writes. A Linux whole-worker
experiment protects policy bytes, including aliases and inherited-descriptor
attempts, by mounting the entire brain read-only and giving the worker a separate
scratch filesystem. Applying that shape requires a ruling on worker isolation
and how interactive edits reach the authoritative brain. This is a recommendation,
not that ruling, a shipping guard, or production containment evidence.

## Why a tool hook or child-only wrapper is insufficient

Claude assembles the ordinary SDK turn, project settings and in-process bridge
tools (`createClaudeSdkTurn`, `packages/ui-backend-claude/src/sdk-options.ts:54-210`).
The installed SDK exposes `spawnClaudeCodeProcess`; the existing adapter wraps
the child with piped stdio (`createWrappedSpawn`,
`packages/ui-backend-claude/src/spawn-wrapper.ts:39-68`). Parent-side MCP/bridge
handlers are outside a boundary around that child. Their effects must be audited
and validated separately; this report does not claim they currently write policies.

Pi creates sessions directly in the server process (`async newSession`,
`packages/ui-backend-pi/src/session-runtime.ts:36-60`). Its resource loader
initializes extensions (`createSessionResources`,
`packages/ui-backend-pi/src/session-resources.ts:31-100`). The permission extension
registers a tool-call handler (`createPermissionGate`,
`packages/ui-backend-pi/src/permission-gate.ts:75-96`); it cannot interpose arbitrary
filesystem calls during extension initialization or execution. The experiment
loads a real pi inline extension and observes its parent-side initialization
changing the policy. Sandboxing only its spawned shell cannot repair that.

Upstream [pi's security policy](https://github.com/earendil-works/pi/security)
places extensions inside the local user's trust boundary. Claude's
[Bash sandbox documentation](https://code.claude.com/docs/en/sandboxing#scope)
distinguishes shell/descendant confinement from built-in file tools and other
execution paths. A Bash sandbox plus path predicates therefore does not establish
the requested all-writer boundary. The repository's Bash classifier documents
indirection as accepted write-lock exposure (`A Bash command the classifier misses`,
`packages/ui-backend-claude/src/tool-policy.ts:211-216`), rather than containment.

## Executable evidence

The private experiment is [probe.py](../../scripts/policy-boundary-spike/probe.py)
with [worker.ts](../../scripts/policy-boundary-spike/worker.ts). It creates and
destroys its own fictional Odysseus files; it never opens a content repository,
uses provider credentials, or makes an inference request. Run from the repository
root after a frozen dependency install:

```sh
set -o pipefail
python3 scripts/policy-boundary-spike/probe.py 2>&1 | tee /tmp/policy-boundary-proof.log
python3 scripts/policy-boundary-spike/probe.py --mutation 2>&1 | tee /tmp/policy-boundary-mutation.log
python3 scripts/policy-boundary-spike/probe.py 2>&1 | tee /tmp/policy-boundary-restored.log
```

The mutation is expected to exit 1. It replaces the brain's read-only binding with
a writable binding. The installed pi Write executor succeeds, scratch writing
still succeeds, and the controller's `POLICY_BYTES_UNCHANGED failed: write under
mutation` assertion fails. This is an observed byte-integrity failure after the
writer executes, rather than a module-load failure. Restoring the normal profile
passes again.

Measured on 2026-10-01: Linux x86_64, kernel
`6.18.33.2-microsoft-standard-WSL2`, Bun `1.3.14`, Python `3.12.3`, bubblewrap
`0.9.0`, Landlock ABI `7`, installed pi coding-agent `0.99.2`, and installed Claude
Agent SDK `0.3.283`. Versions come from the running tools and installed manifests.
The Claude adapter's real spawn function executes a fixture Bun program; the
experiment does **not** run a Claude model turn or its built-in Write/Edit/
NotebookEdit implementations. Notebook serialization and nested subagent-like
processes are fixtures. Installed pi Write/Edit/Bash and extension loading/custom
executors run directly without replacing their filesystem operations. This
distinction limits the proof to the measured boundary and named writers.

The protected profile uses bubblewrap namespaces, a read-only root and brain,
fresh `/proc` and `/dev`, a separate scratch tmpfs, dropped capabilities and a
cleared environment. The launcher closes inherited descriptors above 2. Protocol
stdout/stderr must be pipes; no policy-backed stdio is admitted. No
agent code runs before confinement. This is a reproducible filesystem experiment,
not an R28 network/credential/configuration sandbox: it has no inference egress,
still exposes readable host files, and does not measure hostile Unix sockets,
resource exhaustion or kernel exploits.

The controller checks nonempty original bytes and directory membership from
outside the sandbox, independently of tool return values. Sixteen protected
attempts cover installed Write/Edit, notebook serialization, an indirect Bash
script, nested execution, the Claude spawn adapter, relative traversal, symlink
and preexisting hardlink aliases, creation of a scratch hardlink, new policy
creation, unlink, directory rename, extension initialization/custom execution,
and a descriptor closed before entry. None changes policy bytes or directory
membership. New scratch hardlinks fail across filesystems. Six permitted probes
use the same Write/Bash/nested/Claude-spawn/extension executors in scratch and
read back the expected nonempty payload; they prove the writers were functional.

Six deliberately insufficient configurations produce actual policy changes:

| Configuration | Observed escape | Consequence |
| --- | --- | --- |
| Writable brain with only the policy directory mounted read-only | Installed Write follows a preexisting hardlink in `notes/` to the policy inode | Protecting a pathname does not protect every writable alias. |
| Read-only brain plus a writable host scratch directory | A preexisting policy hardlink in scratch remains writable | Use an isolated scratch filesystem; merely choosing a fresh path is an assumption about its contents and other writers. |
| Whole-worker mounts with an inherited writable descriptor 3 | `write(3, ...)` changes the original file | Explicit closure belongs in the launcher; bubblewrap is not a descriptor sanitizer. |
| Whole-worker mounts with policy-backed stdout | `write(1, ...)` changes the original file | Validate protocol descriptors, including stdio, rather than closing only descriptors above 2. |
| Pi extension initialized in the unsandboxed parent | Installed loader runs the extension factory's filesystem write | Confining a child shell leaves the in-process writer privileged. |
| Landlock applied after a policy descriptor is opened | New policy opens are denied, scratch writes work, but the old descriptor writes | Enter before loading untrusted code and close inherited authority. |

The [Landlock kernel interface](https://www.kernel.org/doc/html/latest/userspace-api/landlock.html#filesystem-flags)
documents the preopened-descriptor limitation. The native x86_64 probe requires
ABI >=3, restricts write/create/remove/refer/truncate rights to scratch, observes
a denied new open, and then writes through the old descriptor. Applying Landlock
late to a live server also cannot split JavaScript closures into different trust
domains or undo earlier opens/mappings. This investigation does not endorse that
as an in-process pi solution.

## Architecture ruling required for implementation

Recommend a concrete worker boundary shared by both adapters, managed inside the
existing server lifecycle. Pi SDK sessions and extension initialization/execution
would live inside workers; the Claude process and any runtime-owned local MCP
executors would also live inside them. No new daemon or extension seam is proposed.
Every worker receives a read-only authoritative brain view and a separate writable
attempt filesystem, pipe-only protocol descriptors and no inherited file/socket
authority. Workers cannot request privileged filesystem handles through the bridge.

The ruling must choose how ordinary interactive effects reach Markdown:

1. **Recommend server-validated effects:** existing curated brain operations run
   through a narrow server-owned path, with explicit operation/path/principal
   authority, descriptor-based race/alias protection, policy and ancestor denial,
   and preserved locking/indexing. Shell/custom-extension edits happen in a
   disposable view and require a bounded validated application step. This changes
   ordinary shell behavior and must be expressly approved; this proof has no
   broker, merge algorithm or ordinary-turn integration to claim ready.
2. **Direct-write alternative:** choose a real separately privileged worker
   identity, policy inode/ancestor ownership and stable mount topology that still
   permits other authoritative brain writes. Prove hardlinks, rename/replacement,
   `/proc`, inherited descriptors, supplementary groups/capabilities and privileged
   bridge effects on the chosen platform. Changing only the numeric UID inside a
   user namespace is not proof of a different host filesystem identity. No such
   layout was implemented or proved here.

Approve the worker model, effect route, supported platforms and refusal behavior
before #674 becomes ready. The measured candidate is Linux/WSL2 with namespaces
and bubblewrap available. macOS and native Windows have no measured result here;
upstream support for a Bash sandbox is not support for this all-writer design.
An implementation must visibly refuse an unsupported mode before SDK/extension
initialization, with no automatic unsandboxed fallback. Preserve one shared tool
availability/enforced-membership mechanism for voice and unattended execution;
the filesystem boundary applies independently to every agent turn.

## Concrete implementation and verification obligations

#674 must incorporate the selected ruling and isolate all runtime initialization
before dispatch. Use the existing AgentBackend interface and server lifecycle for
internal worker communication, retain cancellation/session history and ordinary
turn semantics explicitly, and audit parent-side bridge effects. Assess SDK/wire/
CLI/MCP/HTTP contract impact rather than presuming the worker implementation needs
no contract change. Changed package behavior needs changesets; breaking semantics
need their explicit ruling and same-commit contract documentation.

Its proof must enter through both installed adapters' actual ordinary-turn paths,
using a keyless fixture inference transport, and cover allowed authoritative edits
under the selected effect route. Run all the measured escapes plus mappings,
descriptor/socket transfer, `/proc`/parent process access, topology races and
extension startup before any tool event. Observe original policy bytes and
unrelated permitted results, mutate the integrated guard, and verify unsupported
runtime/platform refusal before code initialization. #676 separately proves the
complete R28/R29/R31 credentials, ambient configuration and egress envelope.
Neither task may treat this finite fixture experiment as autonomous enablement.
