// `bun run lint` — runs every lint gate and aggregates their exit codes.
//
// The list is EXPLICIT, not a scripts/check-*.ts glob: check-dist.ts is a
// publish-time guard wired into prepublishOnly, not a lint, and a glob would
// drag it (and any future non-lint check script) into every lint run. The
// price of an explicit list is that a new lint must be added here — which is
// the point: joining the lint gate is a decision, not a filename side effect.

import { existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

const LINTS = [
  "check-invisibles.ts", // raw control/invisible characters in tracked source
  "check-env-access.ts", // ambient process.env outside per-package chokepoints
  "check-frontmatter-parse.ts", // gray-matter parsing outside the cache-free parseFrontmatter helper (#142)
  "check-module-casts.ts", // `as` casts papering over the module config contract
  "check-leakage.ts", // personal strings anywhere in the tree (CI's leakage gate, runnable locally)
  "check-kit-purity.ts", // ui-kit stays prop-driven: no store, no I/O, no ambient globals
  "check-root-stores.ts", // internal imperative store access must use an explicit root
  "check-oxlint.ts", // oxlint correctness pass (ruleset in .oxlintrc.json)
  "check-ci-workflows.ts", // Single GitHub provider, safe fork execution and no active Depot definitions (#1320)
];

let failed = false;
for (const lint of LINTS) {
  const path = join(ROOT, "scripts", lint);
  console.log(`\n== ${lint}`);
  if (!existsSync(path)) {
    // A missing lint that "passes" is a silently disabled gate. Fail loudly.
    console.error(`scripts/${lint} does not exist — a lint listed in scripts/lint.ts is missing.`);
    failed = true;
    continue;
  }
  const run = Bun.spawnSync(["bun", path, ROOT], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (run.exitCode !== 0) failed = true;
}

if (failed) {
  console.error("\nlint: FAILED (see the gates above)");
  process.exit(1);
}
console.log("\nlint: all gates clean");
