# Research: Tooling Versions & Compatibility (verified live 2026-07-12)

Method: npm registry queries, published-tarball `.d.ts`/docs extraction, GitHub API,
official docs. Two research agents; condensed here. Re-verify before changing pins.

## Version pins (decided)

| Package | Pin | Rationale |
|---|---|---|
| zod | ^4.4.3 | v4 stable; root `zod` import = v4; MCP SDK peers `^3.25 \|\| ^4.0` |
| @modelcontextprotocol/sdk | ^1.29.0 | stable v1; imports `…/server/mcp.js` + `…/server/stdio.js` confirmed current. **v2 beta**: split into `@modelcontextprotocol/server`+`/client`, stable expected ~2026-07-28; migrate later, v1 supported ≥6mo |
| sqlite-vec | ^0.1.9 | latest stable; bun:sqlite `load(db)` pattern unchanged |
| gray-matter | ^4.0.3 | maintenance-frozen since 2021 but battle-tested; frontmatter.ts depends on its exact stringify semantics → keep; revisit post-1.0 (options: vfile-matter@5, in-house splitter + `yaml`) |
| typescript | ^6.0.3 | npm `latest` is 7.0.2 (Go-native, emit pipeline immature). Research agent suggested 5.9.3; we keep 6.0.3 — proven in the reference brain repo AND this monorepo (strict tsc green), and we ship TS source (no `.d.ts` emit), so TS7 emit concerns don't apply |
| @changesets/cli | ^2.31.0 | see release-wiring notes below |
| @earendil-works/pi-* | 0.80.6 (all three, lockstep) | see pi notes in research/pi-omp.md |

## npm / GitHub availability (2026-07-12)

- `brainform` bare npm: FREE (404). `@brainform/core`: FREE; scope appears unclaimed
  (only conclusively verifiable at publish time). **Claim both early.**
- `schlessera/brainform`: exists (private) — this repo. `schlessera/brainform-template`:
  does not exist yet — create at launch from `template/`.

## Bun specifics

- Workspaces: `workspaces: ["packages/*"]` + `"workspace:*"` deps supported;
  `bun publish`/`bun pm pack` rewrite `workspace:*` and `catalog:` to resolved versions.
- **Keep default hoisted linker** — isolated linker + catalog combo broken (oven-sh/bun#23615).
- Catalogs (≥1.2.14) optional; not adopted yet (few shared deps).
- postinstall blocked by default (`trustedDependencies` allowlist only; non-registry sources
  never auto-trusted) → validates the no-postinstall skill-sync decision. Keep bun ≥1.3.5
  (CVE-2026-24910 fixed there).
- **macOS gotcha**: Apple system SQLite blocks extension loading → sqlite-vec segfaults
  unless `Database.setCustomSQLite(<brew libsqlite3>)` is called before any Database
  (oven-sh/bun#5756). Linux/WSL/CI fine. → add a `brain doctor` check + docs note.

## Changesets release wiring (for launch)

Changesets has no native bun support (won't resolve `workspace:*`):
1. version step: `changeset version && bun update` (re-sync lockfile)
2. publish step: per-package `bun publish` (does the rewrite), then `changeset tag`
3. per-package `publishConfig: { access: "public" }`
4. CI: `oven-sh/setup-bun@v2` + `changesets/action` with custom scripts
Source: https://ianm.com/posts/2025-08-18-setting-up-changesets-with-bun-workspaces

## Key source URLs

- https://github.com/modelcontextprotocol/typescript-sdk
- https://alexgarcia.xyz/sqlite-vec/js.html · https://bun.com/docs/runtime/sqlite
- https://bun.com/docs/pm/workspaces · https://github.com/oven-sh/bun/issues/23615
- https://bun.com/docs/guides/install/trusted
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/
