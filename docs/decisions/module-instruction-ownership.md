# Decision — module instructions have an authoritative source and explicit ownership

**Ruled 2026-10-01 by the maintainer on #527.** Binds module instruction
contributions, onboarding, instruction regeneration, module enable/disable
and per-module context estimates.

The maintainer selected two policies:

- [Instruction source/ownership option A](https://github.com/schlessera/brain-kit/issues/527#issuecomment-5933210288):
  structured module contributions produce generated regions with explicit
  module ownership.
- [Existing-brain migration option A](https://github.com/schlessera/brain-kit/issues/527#issuecomment-5934312044):
  legacy mixed sections require explicit migration before a toggle can change
  config, managed skill links or instruction files.

[Issue #527](https://github.com/schlessera/brain-kit/issues/527) owns the
implementation of these policies and module dormancy.
[Issue #603](https://github.com/schlessera/brain-kit/issues/603) owns the
separate MCP registration filter. This record establishes the approved
policy; availability follows those implementations and their releases.

## Why ownership must be explicit

Dormancy preserves a module's content and validated configuration while
removing its workflow from the agent's context. Removing skill discovery
alone leaves module conventions in the instruction files. Removing a shared
section can also delete another module's conventions or personal prose.

The existing module mechanism builds contributions from validated config
(`ModuleContribution`, `packages/core/src/lib/module-types.ts:128-154`). The
generated-region helper replaces a whole named block and preserves bytes
outside it (`replaceGeneratedRegion`,
`packages/core/src/lib/generated-regions.ts:99-120`). Neither a shared block
nor its heading establishes which module owns each paragraph. The CLI needs
an authoritative source and explicit ownership to remove, regenerate and
measure module instructions deterministically.

## Authoritative source and owned regions

Module instruction text comes from structured contributions through the
existing `setup(config)` mechanism, derived from the module's validated
config. First-party conventions must populate that source. Instruction
contributions are optional and validated with the rest of the contribution;
existing manifests need no new required field.

Each generated module region carries explicit ownership. Disabling a module
removes its owned instruction text and managed skill discovery. Enabling it
regenerates that text from its contribution and current validated config.
Shared installed-contract text and personal prose remain independently
owned. They cannot be removed with a module or charged to its context cost.

With unchanged validated config, enable restores the module's generated text
and skill targets byte-identically. Changing config while the module is
dormant produces text from the new validated config on enable, rather than
restoring stale prose from a saved copy. The other module's regions, shared
contract, personal prose, documents and bytes outside changed owned regions
are preserved. Repeated enable or disable is idempotent.

Per-module context estimates count discoverable skill descriptions and
authoritative contributed instruction text. They represent the module's
cost when active, including when it is dormant. Shared contracts and
personal prose are excluded. Changing one module's contribution changes its
estimate without inflating another's.

Configuration and contributions are authoritative. Generated instructions
are derived output; neither `brain.db` nor a backup of generated prose becomes
the source for restoration.

## Explicit migration before toggling

When legacy generated sections mix module conventions and personal prose,
both enable and disable must refuse before changing config, managed skill
links or instruction files. The refusal identifies what needs migration.
Configuration errors and unknown or malformed region ownership likewise
fail before regeneration or toggle side effects.

A user or agent explicitly separates module conventions into the new owned
regions and retains personal prose under user ownership. The CLI never
infers paragraph ownership from a module name and never removes a whole
mixed section to make a toggle succeed. This requires deliberate migration;
it does not reserve the work exclusively for a human.

After migration, a successful toggle retains the full removal/restoration
guarantee. There is no limited-success mode that changes the flag and skills
while leaving dormant module instructions in the context. Onboarding and
module-generation guidance must use the same ownership model so new brains
do not recreate the ambiguity.

## Alternatives rejected

- **Infer paragraph ownership from headings, keywords or module names.**
  Shared sections can contain conventions from several modules and personal
  instructions. The rulings require an explicit separation rather than an
  agent or heuristic guessing which text may be removed.
- **Remove or regenerate a whole mixed shared section.** This cannot preserve
  independently owned personal prose and other modules' instructions. A
  generated marker is a replacement boundary, not proof of module ownership.
- **Report a limited-success toggle for a legacy brain.** Leaving dormant
  prose loaded would break the context-removal promise. The selected policy
  refuses before side effects and requires migration first.
- **Restore a saved copy of generated module prose as the source.** That
  would ignore validated configuration changes. Restoration and attribution
  use the structured contribution source.

## Lifecycle and compatibility remain settled

Dormancy retains the module's validated domain config, document types and
directory anchors; existing content stays valid, searchable and linkable.
The optional `enabled` flag defaults to enabled when omitted. Instruction
contributions and state/list output additions preserve existing fields and
ordinary enabled-module behavior. The rulings authorize additive contract
work, requiring a same-commit integration-contract update, `CONTRACT:` prefix
and minor changesets when implemented. They authorize no breaking change.

The [MCP lifecycle decision](module-mcp-tools.md#7-lifecycle-dormancy-stale-handles-in-flight-calls)
continues to bind: the next server process filters tools using the loaded
module state, while a running process keeps its registered tool set. Calls
in flight finish; completed effects are not rolled back. Dormancy controls
context and is not permission revocation. Dynamic tool lists remain outside
this policy.

Implementation evidence must cover nonempty contributions from two modules
and nonempty personal/shared-contract text: refusal snapshots with no side
effects, isolation, unchanged-config restoration, changed-config
regeneration, idempotence and per-module attribution. The acceptance criteria
and verification receipts live in #527.
