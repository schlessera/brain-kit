// Runs oxlint (check-only) with the curated config in .oxlintrc.json.
//
// Thin wrapper so the standard linter joins `bun run lint` like the bespoke
// AST gates: scripts/lint.ts stays a plain list, and the ruleset lives in one
// reviewable config file rather than in CLI flags. `bunx` resolves the oxlint
// pinned in the root package.json, so CI and local runs lint identically.

import { join, resolve } from "path";

const ROOT = resolve(process.argv[2] ?? join(import.meta.dir, ".."));

const run = Bun.spawnSync(
  ["bunx", "oxlint", "-c", join(ROOT, ".oxlintrc.json"), "packages", "scripts", "tests"],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" }
);

process.exit(run.exitCode ?? 1);
