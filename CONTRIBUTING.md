# Contributing

brain-kit is maintained by one person. Contributions are welcome; expectations
are calibrated accordingly — reviews may take days, and scope is guarded
deliberately.

## Running the code

```sh
bun install
bun test            # all packages
bun run typecheck   # strict tsc, no emit
```

Tests and typecheck run from live TS source — no build needed. The
`node_modules/.bin/brain` bin, however, points at the compiled CLI, so run
`bun run build` once before invoking it directly (or use
`bun packages/core/src/cli/brain.ts`).

Tests must stay keyless and deterministic: integration tests run against
`packages/core/fixtures/corpus/` with FTS-only search. Never add a test that
needs an API key or the network.

## The rules that will get a PR merged

1. **Contract changes** (CLI `--json` shapes, MCP tool names/schemas, db
   `schema_version`, frontmatter semantics): update
   `docs/integration-contract.md` in the same commit, prefix the commit with
   `CONTRACT:`, and expect a major-version discussion first.
2. **No new seams.** Extension interfaces exist only where a second
   implementation is plausible within a year. The explicitly-not-pluggable
   list in the README is final: no storage providers, no framework adapters,
   no protocol plugins.
3. **Contributing a provider** (the intended extension path, ≤3 steps):
   implement the typed interface (`defineConfig` accepts your value directly),
   prove it against the interface's contract test, and optionally publish as
   `brain-kit-<kind>-<vendor>`. Community providers are only promoted to
   built-ins once they have real users.
4. **Modules** own content domains (types, skills, one CLI namespace) — see
   `docs/extending/`. Run `brain module lint` before submitting.
5. **No personal data** in fixtures or examples — the CI leakage gate will
   reject known private strings; use the "Alex Example" persona.
6. Versioning is lockstep across `@schlessera/brain-*` via changesets; add a
   changeset to any user-visible change. Keep the changeset itself short —
   what was added / changed / removed, in one line each. The commit it links to
   carries the reasoning.

## Releasing

`bun run version` (changesets), then `rm bun.lock && bun install` — bun resolves
`workspace:*` pins from the installed lockfile, so a stale one publishes
manifests pinning the previous, never-published version. Then `bun run release`.

Two config details keep the lockstep bump honest, and removing either silently
turns every release into a major (0.4.0 → 1.0.0 instead of 0.5.0):

- `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`
  is `true` in `.changeset/config.json`. Changesets otherwise majors any package
  that peer-depends on something being released — regardless of the range, and
  regardless of `peerDependenciesMeta.optional`.
- `@schlessera/brain-ui-server`'s peer dependency on the optional
  `@schlessera/brain-backend-pi` is ranged `*`, not `workspace:*`. Changesets
  can't evaluate the `workspace:` protocol as a semver range, so it treats every
  new version as out of range and majors anyway.

With the `fixed` group, one such major promotes all ten packages.

## What not to send

Framework rewrites, storage backends, editor plugins, "AI-generated
improvement" sweeps without a driving use case, or features that require a
daemon. Open a discussion first when unsure.
