# Decision — package ranges and runtime minimums compose

The maintainer's ruling in [#210](https://github.com/schlessera/brain-kit/issues/210),
dated 2026-09-28, keeps the Claude Agent SDK dependency range. Both a package
and its consuming host can declare requirements. The host need not have a
version or a release process: its checked-in manifest, configuration and
lockfile describe the requirements of that checkout.

This record specifies the implementation boundaries. Host/context composition
and backend enforcement implement these declarations in #642 and #643. It supplements
[claude-code-runtime.md](claude-code-runtime.md): compatibility requirements
do not replace the measured-pair warning, permission probes or provenance.

## Identity and ownership

Dependencies point from the host to public packages to their dependencies and
runtimes. A public package never requires a particular host application version.

| Identity | Requirement owner and declaration | Evidence of the version used |
| --- | --- | --- |
| A brain-kit package imported by the host | The host's `dependencies` range | Manifest beside the entry resolved from that host importer; its compiled exports must also build |
| An SDK imported by a backend | That backend's published `dependencies` range; optional stricter host SDK minimum | Manifest beside the SDK entry resolved from the backend importer |
| A backend's executable runtime | Optional package-owned runtime minimum and optional host runtime minimum | Existing backend probe of the command a turn would spawn, including an override |
| Content `brain` CLI | ui-server's existing minimum and optional stricter host minimum | `--version` of `brainCliCommand(brainPath)` through the actual exec wrapper |
| Bun | Package `engines.bun` and the host's engine declaration | Bun executing that process, independently of the package manager used to install |
| Index schema | Existing reader-specific schema requirements | The disposable database's metadata, never a package or executable version |

The host's copy of `@schlessera/brain` does not answer for the CLI in the
content checkout. Likewise, a root-level SDK does not answer for a nested SDK
loaded by a backend. Each importer validates its own used copy; multiple valid
copies may coexist. A check never crawls an unrelated install tree or treats a
lockfile entry as evidence that a particular module was loaded.

For Pi, the reported primary SDK is `@earendil-works/pi-coding-agent`; a host's
`sdk` floor addresses that identity. The backend separately validates each
imported Pi SDK dependency against its own manifest requirement, including
`pi-agent-core` and `pi-ai`. It has no separate executable runtime to constrain;
a requested runtime minimum must report that verification is unsupported.

For the supported unbundled server/backend packages, resolving next to the
actual importer and reading the adjacent manifest is the boundary. Require the
expected package name as well as a version. A missing, renamed or malformed
manifest is unknown identity, not a fallback to a convenient root copy. Hosts
that bundle server code must preserve this identity/metadata boundary or fail
verification; this design adds no bundler adapter or general dependency graph.

## Declarations

**Packages use their manifests for package requirements.** There is no second
SDK range constant. The Claude backend reads its own dependency range when
checking the actual SDK. A release that changes it changes the manifest and
lockfile using the release workflow. Existing upper bounds remain binding.

Runtime requirements that a package manager cannot enforce use an internal
constant beside the owning runtime probe, with a comment citing the feature or
incompatibility that justifies it. The CLI's `MIN_BRAIN_CLI_VERSION` remains the
single exported source of its floor. A Claude runtime floor, when justified,
belongs to the Claude backend, not to the server or `MEASURED_RUNTIME`.

**Hosts use manifests for imported package requirements and explicit checked-in
values for separately selected runtime/SDK minimums.** Add this optional shape
to the existing `CreateAppOptions` boundary:

```ts
interface HostVersionRequirements {
  brainCli?: string;
  backends?: Readonly<Record<string, {
    sdk?: string;
    runtime?: string;
  }>>;
}

// createApp({ versionRequirements: requirements, ...existingOptions })
```

Each value is one full SemVer minimum, not a range, path, npm tag or URL.
`sdk` is scoped to the named backend's reported SDK; `runtime` to its reported
executable. Validate the whole configuration at app construction. Unknown
backend ids, inactive backends, or a requested SDK/runtime identity that the
backend cannot verify are configuration errors with an activation/removal hint.
An omitted requirement adds no host constraint. An empty value is an error.

Thread a backend's two host minimums through the existing
`BackendModuleContext`, to both `probeRuntime` and `resolveFromEnv`. Direct
backend construction receives the same optional pair in its factory options.
The backend enforces its own SDK range in both construction and probing, so a
consumer bypassing ui-server still receives package-owned enforcement.
Runtime minimums are enforced before an invocation releases a user prompt.
These are additions to existing boundaries, not a new provider or registry.

An injected registry must not silently bypass explicit host requirements.
Without requirements, keep its existing embedding/test behavior. With them,
the registry must provide the applicable verified identities through its
existing backend descriptors, or app construction refuses with an actionable
unsupported-verification error. Third-party backends need not implement
runtime probing until a consumer requests a constraint on that identity.

The host can use an ordinary root `overrides` declaration to choose a narrower
SDK resolution, but the loaded-copy check still applies. The override is an
installation choice; the explicit minimum is the host's requirement. Do not
infer intent from an override or promise that a direct dependency deduplicates
all transitive copies. [Bun's override documentation](https://bun.sh/docs/pm/overrides)
and [npm's manifest documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides)
describe the resolution mechanism. Verify the generated example on the
supported installed Bun before documenting its exact resolution behavior.

## Composition and version grammar

A detected version must satisfy **every applicable constraint**. Do not pick
the last setting, replace a package range with a host minimum, or calculate a
maximum floor and drop an upper bound. For an SDK, the checks are its owner's
original package range and `>=` the optional host minimum. For a runtime/CLI,
the checks are the package minimum, if any, and the host minimum, if any.
Diagnostics retain the owner of each constraint even when one is redundant.

For example, `^0.3.241` and a host SDK minimum of `0.3.283` admit stable
`0.3.283` through `0.3.x`, but never `0.4.0`. A weaker host floor of `0.3.200`
does not admit `0.3.200`. A host floor of `0.4.0` has no solution under that
package range: report the conflicting declarations, including the upper bound,
rather than suggesting an override that breaks the package requirement.

Use strict `node-semver` validation and comparison, with `loose: false` and
the normal prerelease exclusion. This requires a declared runtime dependency
where the helper ships, not reliance on a transitive development install.
Reject blank strings and non-ASCII input before validation. Host minimums are
full `major.minor.patch` SemVer, with optional prerelease/build identifiers;
reject `v`, `=`, partial versions and leading zeros. Command-specific parsers
may strip a known `v` prefix or Claude's ` (Claude Code)` suffix before strict
validation, but never coerce arbitrary text into a version.

Compare build metadata without affecting precedence. A prerelease is below
the corresponding stable release. An explicit prerelease minimum opts into
prereleases of that same numeric tuple under node-semver's normal rule; every
other applicable range must independently admit it. There is no global
`includePrerelease` switch. For an OR range, retain each range's normal
semantics; intersection means testing all original requirements, not joining
range strings and accidentally distributing `||` incorrectly.

[Bun documents](https://bun.sh/docs/runtime/semver) that its range checker
ignores unparseable range fragments. On Bun 1.3.14, both `garbage` and
`^0.3.241 garbage` accepted `0.3.283`. The installed node-semver 7.8.5
`validRange` returned `null` for each; an empty range returned `*`, which is
why explicit blank validation is also necessary. These are observations from
2026-09-30, not assumptions about another Bun release. The
[node-semver reference](https://github.com/npm/node-semver#prerelease-tags)
defines the prerelease behavior used here.

## Enforcement and unknown versions

| Boundary | Decision |
| --- | --- |
| Install/build | Frozen install resolves manifest ranges. The generated host's build verifies its own declared imported packages from its entry point, in addition to compiling those imports. Reject conflicting/invalid package requirements; never auto-install at boot. |
| Backend construction/boot | Check the backend's loaded SDK against its own manifest range and any host floor. A known violation, unreadable identity or invalid declaration refuses construction. Probe the selected runtime using the existing wrapper/environment/working-directory path. Missing binary, timeout, nonzero exit or malformed output refuses boot, as Claude's existing probe already does. |
| Content CLI boot | A known version below either floor refuses boot. With no explicit host floor, preserve the existing warning-and-continue policy for failed/unparseable probes. With an explicit host floor, inability to verify it refuses boot. A host cannot opt a known violation back into warning-only behavior. |
| Invocation | Revalidate a replaceable override and the content CLI before use when a constraint applies; do not cache a successful boot as proof about a subsequently replaced executable. Loaded SDK metadata is process-stable and may be cached by resolved copy. |
| Session observation | Preserve `init` runtime/provenance reporting. A reported violation aborts the turn and produces its normal terminal error; it never overwrites or suppresses the actual observation. |

For runtime-constrained turns, check the selected executable immediately before
start/resume and hold the streaming user prompt until the SDK handshake has
completed. Compare any version identity available before prompt release; a
missing mandatory observation is a verification failure. Claude's runtime
version currently arrives in `system/init`, which is too late to be a
pre-prompt check. Therefore use the bounded executable probe before prompt
release, and treat `init` as additional evidence rather than the gate. A
changed `init` version still ends the turn, but cannot undo a sent prompt.
The immutable executable/installation requirements remain necessary: no probe
can close a replacement race by itself. Do not claim it can.

The content CLI is independently replaceable as documented by
`brainCliCommand`; recheck before each CLI invocation under an explicit host
floor, retaining the package-owned known-version check for the default floor.
The existing bounded probe and group cleanup are reused; a new probe must not
leave a wrapper child alive. This does not impose a Claude chat requirement on
the different Claude runtime a core sync runner chooses. That runtime remains
per-run observation unless a separately scoped core requirement is introduced.

Default CLI unknown handling is deliberate compatibility behavior already
tested. Opting into a host minimum opts into verified enforcement. There is
no catch-all downgrade from a failed explicit requirement to a warning.
Package runtime floors, if subsequently introduced, also require successful
verification. Inactive optional dependencies are not probed.

Failures name the requirement owner, component/identity, declared range or
minimum, detected version (or `unknown` and reason), phase, and action. For
example: `host requires claude SDK >=0.3.283; detected 0.3.280 in the SDK
loaded by @schlessera/brain-backend-claude; update the host lockfile within
the backend range ^0.3.241 and rebuild`. A range violation names the backend
as owner and includes the full range. A conflicting host floor suggests an
appropriate package upgrade or corrected requirement, never bypassing a gate.
Paths may appear in local diagnostics; public fixtures use temporary paths.

## Initial numeric requirements and their evidence

| Requirement | Initial value | Evidence and limit of the claim |
| --- | --- | --- |
| Claude backend's SDK range | Retain `^0.3.241` | It is the published declaration (`"@anthropic-ai/claude-agent-sdk"`, `packages/ui-backend-claude/package.json:48`). Registry metadata on 2026-09-30 confirms 0.3.241 exists. This is a declared compatibility bound, not proof every allowed release passed current measurements. |
| ui-server's content CLI floor | Retain `0.33.0` | `--` support is the reason documented immediately above `MIN_BRAIN_CLI_VERSION` (`MIN_BRAIN_CLI_VERSION`, `packages/ui-server/src/brain/client.ts:88`); the boot refusal test uses 0.32.9 (`a below-minimum brain repo pin`, `packages/ui-server/tests/brain-client.test.ts:236-245`). |
| Bun engine floor | Retain existing `>=1.3.5` declarations | Existing engine metadata and the doctor's CVE-based warning (`const MIN_BUN`, `packages/core/src/cli/commands/doctor.ts:43`; `function checkRuntime`, `packages/core/src/cli/commands/doctor.ts:80-87`). This record introduces no new doctor verdict or blanket boot gate. |
| Pi SDK requirements | Retain existing exact `0.87.1` declarations | `packages/ui-backend-pi/package.json`; a host floor composes with each actual imported Pi dependency's existing exact requirement. The Claude range ruling does not authorize changing Pi's pins. |
| Additional default Claude runtime floor | None | There is no evidenced numerical incompatibility threshold in the existing record. The successful pairs are observations, not proof that the preceding release fails. A new library floor needs a feature requirement or reproducible incompatibility and its versioning review. |
| Example host SDK/runtime floors | `0.3.283` / `2.1.283` | The installed SDK manifest and `MEASURED_RUNTIME` (`export const MEASURED_RUNTIME`, `packages/ui-backend-claude/src/measured-runtime.ts:18-25`) identify this measured pair, rechecked in commit `e1ce9600`. This is a host choosing the demonstrated baseline, not a new default package floor. |

**Pi pin update, 2026-09-30 ([#708](https://github.com/schlessera/brain-kit/issues/708)):**
The initial `0.87.1` Pi pins above are historical. The separately scoped
catalog update moves all three to published `0.99.2` to support GPT-6.1 Sol
on OpenAI and OpenAI Codex. Host requirements still compose with each actual
imported dependency's exact manifest requirement; the Claude range ruling
does not select Pi versions.

The example's brain-kit `^0.39.0` range names the public release verified in
the npm registry on 2026-09-30. It expresses a host checkout's package baseline;
it does not assign that host a version. Future examples must use the release
that actually ships the new options. Raising a package bound requires evidence
and the compatibility review for that change; it must not follow automatically
from a measurement constant moving.

## Public examples

The existing library declaration is ordinary dependency metadata:

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.241"
  }
}
```

A fictional self-hoster can require published components and select an SDK
inside the package's range in its own root manifest, with no host version:

```json
{
  "private": true,
  "dependencies": {
    "@schlessera/brain-ui-server": "^0.39.0",
    "@schlessera/brain-backend-claude": "^0.39.0"
  },
  "overrides": {
    "@anthropic-ai/claude-agent-sdk": ">=0.3.283 <0.4.0"
  }
}
```

The checked-in app options additionally express the requirements
that resolution of those packages cannot prove:

```ts
const versionRequirements = {
  brainCli: "0.33.0", // This CLI lives in the separate content checkout.
  backends: { claude: { sdk: "0.3.283", runtime: "2.1.283" } },
};
// Pass versionRequirements to createApp; direct factories accept their backend pair.
```

The example deliberately makes an unknown content CLI version an error. The
override alone cannot constrain an explicit `CLAUDE_CODE_PATH`; the runtime
minimum does. Commit the resolved lockfile, verify the used copies and rebuild
frozen. No boot-time registry requests, updater, dependency installation or
reciprocal host-version negotiation is involved.

## Existing checks retained or updated

| Existing boundary | How this design uses it |
| --- | --- |
| `probeBrainCliVersion` / `brainCliCommand` (`export async function probeBrainCliVersion`, `packages/ui-server/src/brain/client.ts:110-161`) | Reuse executable selection, wrapper, deadline and cleanup; add host floor composition, strict comparison and invocation verification without duplicating the 0.33.0 constant. |
| `installedAgentSdkVersion` (`export function installedAgentSdkVersion`, `packages/ui-backend-claude/src/runtime-probe.ts:55-61`) | Retain importer-relative resolution; validate package name/version and the owner's manifest range. |
| `selectedSpawn` / `probeClaudeRuntime` (`export function selectedSpawn`, `packages/ui-backend-claude/src/runtime-probe.ts:69-96`; `export async function probeClaudeRuntime`, `packages/ui-backend-claude/src/runtime-probe.ts:127-147`) | Keep SDK-selected command capture, native/JS override argv, environment, timeout and group cleanup; add strict identity validation and composed runtime floors. |
| `probeBackendRuntimes` (`export async function probeBackendRuntimes`, `packages/ui-server/src/agent/backend.ts:382-429`) | Forward validated host requirements; retain active-backend selection and separate unmeasured-pair logging. |
| `BackendModuleContext` / `BackendRuntimeReport` (`export interface BackendModuleContext`, `packages/ui-sdk/src/server/backend-module.ts:96-107`; `export interface BackendRuntimeReport`, `packages/ui-sdk/src/server/backend-module.ts:114-127`) | Extend the existing construction context for optional minimums. Keep report identities and `measured` meanings; a compatibility result must never occupy `measured.matches`. |
| `MEASURED_RUNTIME`, its guard and `scripts/measure-claude-runtime.ts` | Keep the constant, exact pair guard, keyless behavior probe and dated measurement receipts. A permitted pair can still be unmeasured. |
| Turn `reportRuntime` / `init` (`const reportRuntime`, `packages/ui-backend-claude/src/turn-runner.ts:147-154`; `if (msg.type === "system"`, `packages/ui-backend-claude/src/turn-runner.ts:432-447`) | Preserve actual per-turn SDK/runtime observations, billing/permission guards and normal failure terminal behavior. |
| Index schema and graph floors | Remain reader-specific integer schema checks; do not compare them as SemVer or turn `brain.db` into authoritative state. |

No new compatibility HTTP status field is required for enforcement. Keep
version details behind authenticated `/api/status`; `/api/health` stays public
and version-free. Any later report extension needs its own API/contract review.

## Alternatives rejected

- **Exact Claude SDK pin.** The maintainer selected a range so hosts can take
  upstream fixes deliberately within the supported bounds.
- **Use the measured pair as the only admitted pair.** A measurement is not a
  compatibility threshold and is not a claim that an unmeasured release fails.
- **Host minimum overwrites package requirement.** This discards upper bounds
  and lets a consumer weaken the library's own requirements.
- **Inspect only the root lockfile.** It can describe an installed copy other
  than the one loaded or a runtime replaced by an override.
- **One new generic compatibility plugin/host-version protocol.** The existing
  manifest, app-options, descriptor and probe boundaries suffice. The dependency
  direction requires no versioned host application.
- **Warn on any explicit requirement that cannot be verified.** This silently
  removes the constraint the consumer requested. Preserve only the already
  established default CLI unknown policy.

Implementation is tracked in [#642](https://github.com/schlessera/brain-kit/issues/642)
(server/context composition and content CLI) and
[#643](https://github.com/schlessera/brain-kit/issues/643) (backend SDK/runtime
enforcement). Generated-host build verification and examples belong to
[brain-hosting-template#7](https://github.com/schlessera/brain-hosting-template/issues/7),
under the existing hosting epic. Their verification includes keyless loaded-copy fixtures,
native/JS overrides, below-minimum and conflicting requirements, strict invalid
input, prereleases, default-versus-explicit unknown behavior and mutations of
the enforcement paths. The implementation adds optional factory minima and Pi SDK-only reports while
retaining the declared package ranges, numeric defaults and measured meanings.
