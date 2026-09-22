// Runs oxlint (check-only) with the curated config in .oxlintrc.json.
//
// Thin wrapper so the standard linter joins `bun run lint` like the bespoke
// AST gates: scripts/lint.ts stays a plain list, and the ruleset lives in one
// reviewable config file rather than in CLI flags. `bun x` resolves the oxlint
// pinned in the root package.json, so CI and local runs lint identically.
//
// It is spelled `bun x` and not `bunx` on purpose: `bunx` is a separate PATH
// entry that bun's installer creates — a symlink back to `bun` dispatched on
// argv[0] — so an environment can have bun and no bunx, and this gate would be
// the only one that cannot run there.

import { join, resolve } from "path";

const ROOT = resolve(process.argv[2] ?? join(import.meta.dir, ".."));

const run = Bun.spawnSync(
  ["bun", "x", "oxlint", "-c", join(ROOT, ".oxlintrc.json"), "packages", "scripts", "tests"],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" }
);

process.exit(run.exitCode ?? 1);
