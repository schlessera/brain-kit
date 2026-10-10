# @schlessera/brain-common

Internal helpers shared by the `@schlessera/brain-*` packages. **Not a
supported API:** both entry points are internal in the sense of the
[public export boundary](../../docs/decisions/public-export-boundary.md). They
may change in any release and are only valid at the same lockstep version as
the package that imports them. Install a brain-kit package instead of this
one; it arrives as their dependency.

| Entry point | What it holds |
| --- | --- |
| `@schlessera/brain-common/internal/env` | The environment descriptor contract (`EnvVarSpec`, `DynamicEnvReadSpec`), `readEnvVar`, and the boolean parsers `envFlag` and `envPresent`. Each package keeps its own `src/config/env.ts` chokepoint on top of it. |
| `@schlessera/brain-common/internal/frontmatter` | `parseFrontmatter`, the only door to gray-matter's parser. It always passes an options object, so gray-matter's process-wide cache is never read or written ([decision](../../docs/decisions/frontmatter-parsing.md)). |

Nothing else belongs here. A further helper needs its own issue and a reason
it cannot live in the package that uses it.
