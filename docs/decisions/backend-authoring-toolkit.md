# The supported backend-authoring toolkit

The maintainer's [2026-09-28 ruling on #343, question 2](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5865700133)
chooses a small documented toolkit, including approval requests and edited-input
validation, with all types reachable through its public signatures. Question 1
requires incidental shared helpers to leave ordinary public entry points.
This record defines the Q2 inventory; the package-wide boundary follows the
same classification in #534.

## Inventory

Public below means an intentional authoring API: experimental until 1.0, then
stable under the project's contract-versioning policy. Internal means available
only for first-party implementation sharing through an explicitly named
`/internal` entry point, with no compatibility promise. It is not another seam.

| Family / names | Classification | Reason |
| --- | --- | --- |
| `decideToolPermission`, `ToolPermissionDecisionInput`, `ToolPermissionApproval` | Public, SDK `/server` | A runtime adapter needs to decide whether to ask before executing. Returning `null` means no approval is needed; a `tool` approval grants a tool, while a `command` approval confirms one use. |
| `createToolPermissionRequest`, `CreateToolPermissionRequestInput` | Public, SDK `/server` | Adapters translate runtime calls into host requests without duplicating the distinction between request kinds or the enforced-allowlist marker. |
| `requestToolPermission`, `RequestToolPermissionOptions` | Public, SDK `/server` | Adapters need the shared fail-closed bridge operation and no-grant-surface handling, including a single JSON snapshot of edited arguments. |
| `checkEditedApproval`, `EditedApprovalCheckInput` | Public, SDK `/server` | An approval of one input must not authorize an edit requiring a different confirmation. Runtime adapters must validate before dispatch. |
| `BackendBridge`, `BackendActivityEvent`, `PermissionRequest`, `PermissionDecision` and their signature-reachable protocol types | Public, SDK `/server` | These are the host boundary and observable outcomes of the toolkit. The signature report traverses them; public input/output types do not become private merely because they are referenced transitively. |
| `ConfirmPattern`, `ConfirmPatternSource`, `CompiledConfirmPattern`, `compileConfirmPatterns` | Public, SDK `/server` | External authors accept configurable confirmation policies and compile them before a runtime starts. Both supported source formats, ordering and invalid-entry behavior are part of the API. |
| `DEFAULT_CONFIRM_BASH_PATTERNS` | Internal, SDK `/internal`; Claude `/internal` retains its alias | This is the project's bundled selection, not a reusable authoring operation. Backend constructors select it when configuration is missing; authors supply their own policy through the public formats. |
| `ARCHIVING_UPDATE_REASON`, `archivesDocument`, `bashCommand` | Internal, SDK `/internal` | These are implementation details of the public decision/edit checks and first-party rewriting/lock selection. An author can use the public permission operations without reproducing them. |
| `SubprocessEnvAudience`, `SUBPROCESS_ENV`, `filterSubprocessEnv`, `parseSubprocessEnvExtra` | Internal, SDK `/internal` | The filter is coupled to the project's subprocess audiences, environment descriptor and escape hatch. External runtimes have different environment needs; this table is not a new infrastructure seam. The documented operator configuration still has its own compatibility guarantees. |
| `SubscriptionAuthAction`, `subscriptionAuthAction`, `SUBSCRIPTION_AUTH_INSTRUCTIONS`, `SUBSCRIPTION_RELOGIN_PROCEDURE` | Public, SDK root, `/protocol` and `/server` | The wire contract already documents the error-class/action mapping and shared actionable instructions. Independent clients and backends consume them. Q2 does not authorize deleting an existing protocol guarantee as an incidental helper. |
| Claude `VOICE_ALLOWED_TOOLS` | Internal, Claude `/internal` | A tool list belongs to one runtime's names and permission posture. External authors must enforce or reject the documented turn posture, not copy this list as a universal policy. |
| Claude `DEFAULT_ALLOWED_TOOLS`, `MUTATING_TOOLS` | Internal source; absent from the ordinary package entry point | Auto-allow and lock tables are runtime implementation policies. No additional cross-package export is needed. |
| Pi `DEFAULT_PI_ALLOWED_TOOLS`, `TOOL_RISK` | Internal, Pi `/internal` | These are the pi runtime's default grant list and risk/lock classification. Pi has no separate exported voice list; voice uses the host-supplied restricted posture. |

This inventory covers Q2's families, not every export of these packages. Other
constructor, descriptor, transcript, lock, tool and profile APIs remain subject
to the package-wide inventory in #534; sharing a server entry point with the
toolkit does not classify them implicitly.

The public permission implementation is the gate (`decideToolPermission`,
`packages/ui-sdk/src/server/permission-gate.ts:62-96`), request construction
(`createToolPermissionRequest`, `packages/ui-sdk/src/server/permission-gate.ts:205-219`),
bridge operation (`requestToolPermission`, `packages/ui-sdk/src/server/permission-gate.ts:254-292`)
and edited-input check (`checkEditedApproval`,
`packages/ui-sdk/src/server/permission-gate.ts:148-180`). Pattern compilation is
shared (`compileConfirmPatterns`, `packages/ui-sdk/src/server/confirm-patterns.ts:91-128`).

## Behavior and policy defaults

The toolkit does not execute a tool. The adapter must wait for the decision,
honor denial, validate any edited input and dispatch only the checked snapshot.
The documented workflow and those observable guarantees are part of the
supported API, alongside its types:

- A call outside the exact, case-sensitive allowlist needs a tool approval.
  An allowlisted shell call matching a confirmation pattern, or an update
  setting `status: "archived"`, still needs a command approval. Tool grants
  must not substitute for per-use confirmation.
- A missing bridge denies. `noGrantSurface` denies both request kinds without
  asking the host. Denial activity is reported when a reporter exists; a
  throwing reporter cannot change the denial. A bridge rejection remains a
  rejection for the adapter to turn into its runtime's tool error.
- An allowed `updatedInput` is snapshotted once as JSON. Non-object or
  unserializable edits are denied. The adapter checks that snapshot with
  `checkEditedApproval` and uses the same object when applying it.
- An edit needing no per-use confirmation may pass. An edit needing one may
  pass only if every confirmation was covered by the original input: the
  same full command and, for an archive update, the same document. An own
  `__proto__` key is rejected. Tool names and command contents are not guessed.
- Pattern sources are strings or `{ pattern, effect }`. Compilation is
  case-insensitive; input order and the first matching effect are retained.
  Mixed invalid/valid sources report invalid entries and keep valid ones.
  A nonempty list with no valid expression throws; `[]` intentionally disables
  pattern confirmation. This is the [confirmation-policy ruling](confirm-patterns.md).

Bundled defaults can evolve: their precise entries, ordering and explanation
wording are not immutable compatibility promises. Such changes must be
documented as user-visible changes and preserve the guarantees above and the
separate [voice-permission rules](voice-permission.md). The supported policy
formats, explicit-empty behavior, denial/edit semantics and promised posture
are not exempt from versioning just because a default table was edited.
Subscription instruction wording may improve while remaining actionable;
documented action values and mapping behavior remain contract surface.

The toolkit remains experimental before 1.0. Contract changes still need a
`CONTRACT:` commit and same-commit integration documentation; additions ship in
minors, and pre-1.0 breaks require a prior ruling, the `breaking` label and a
minor changeset naming the break. From 1.0, a supported signature, reachable
type or behavioral break requires a major. This does not schedule 1.0 or freeze
interfaces early.

## Migration and evidence

The Q1/Q2 cleanup moves the internal names above out of ordinary exports.
First-party cross-package code imports them from the owning package's
`/internal` path and uses the same lockstep version. All three export conditions
serve one source: Bun source, built JavaScript and built declarations. The
internal paths carry no supported extension API and may change between releases.
Third-party backend authors use `/server`'s documented operations and their own
configured policies instead of importing the project's tables.

`api-report/ui-sdk.txt` records the five public operations and all reachable
types. Runtime tests import ordinary package entries and assert both the public
operations and exclusion of internal names. A scripted backend binding uses
those public operations before writing a dispatch receipt: a denied call or an
unconfirmed edit must leave no file; an allowed safe edit writes the exact
snapshot. The shipped adapters also run the published backend contract suite.
Built consumer probes resolve internal and public paths without forcing source
conditions. Mutating the denial, no-grant or edited-input checks must fail at
the dispatch assertion, not merely at a diagnostic or module-load error.

## Alternatives rejected

- Freezing every shared export would turn implementation tables into permanent
  authoring APIs merely because two first-party packages use them.
- Hiding all permission helpers would make external adapters copy sensitive
  logic, including snapshot and edited-confirmation handling.
- Keeping ordinary exports with a distant internal disclaimer would leave the
  package entry point and supported inventory disagreeing, contrary to Q1.
- Treating default updates as a blanket compatibility exemption would allow a
  promised denial or posture guarantee to change without a ruling or release
  record. The permitted flexibility concerns default entries, not guarantees.
