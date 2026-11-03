# @schlessera/brain-common

Internal helpers shared by the `@schlessera/brain-*` packages. **Not a
supported API:** every entry point is internal in the sense of the
[public export boundary](../../docs/decisions/public-export-boundary.md). They
may change in any release and are only valid at the same lockstep version as
the package that imports them. Install a brain-kit package instead of this
one; it arrives as their dependency.

| Entry point | What it holds |
| --- | --- |
| `@schlessera/brain-common/internal/env` | The environment descriptor contract (`EnvVarSpec`, `DynamicEnvReadSpec`), `readEnvVar`, and the boolean parsers `envFlag` and `envPresent`. Each package keeps its own `src/config/env.ts` chokepoint on top of it. |
| `@schlessera/brain-common/internal/frontmatter` | `parseFrontmatter`, the only door to gray-matter's parser. It always passes an options object, so gray-matter's process-wide cache is never read or written ([decision](../../docs/decisions/frontmatter-parsing.md)). |
| `@schlessera/brain-common/internal/worker-areas` | The hosted worker's write-area names and the rules stated about them: turn temp is never linked, the link rule, and the read-only-brain rule. The ui-sdk's sandbox note and core's `brain` CLI refusal both render them, so the refusal repeats the note word for word (#1654, admitted by #1693). |
| `@schlessera/brain-common/internal/protected-paths` | The protected worker path tiers shared by core policy validation and the sandbox. |
| `@schlessera/brain-common/internal/governance-policy` | Data-only policy schema, defaults, parsing and anchored reads shared by the core CLI and hosted server (#1744). The server can read policy without installing its optional core peer. Its policy writer reads and re-checks the file through the same descriptor-anchored reader (#2508). |
| `@schlessera/brain-common/internal/index-location` | Where the disposable search index lives: the `.brain-index/` directory holding `brain.db` and its SQLite sidecars, and the legacy root-level names a brain migrates away from by rebuilding (#1668). |
| `@schlessera/brain-common/internal/claude-subscription` | The subscription billing guard both Claude runners apply: the cleared credential variables, the neutralised flag settings, the settings refusal and the account verdict. core's CLI runner and the chat backend import it, so a newly found credential or routing variable is added once (#2493). |
| `@schlessera/brain-common/internal/safe-path` | Symlink-safe path containment: `isWithin`, the containment primitive whose equality, separator, trailing-separator and normalisation answers are explicit parameters, and `resolveContained`/`resolveContainedSync`, one canonicalisation algorithm that resolves a request under the root's realpath through its nearest existing ancestor. core's `safeResolve`, the SDK's `resolveInRepo` and the server's `safeResolve` are thin wrappers that each keep their own request refusals and policy, so a hardening fix lands once (#2506). |

Nothing else belongs here. A further helper needs its own issue and a reason
it cannot live in the package that uses it.
