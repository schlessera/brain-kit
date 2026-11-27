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

export const LINTS = [
  "check-invisibles.ts", // raw control/invisible characters in tracked source
  "check-env-access.ts", // ambient process.env outside per-package chokepoints
  "check-frontmatter-parse.ts", // gray-matter parsing outside the cache-free parseFrontmatter helper (#142)
  "check-inline-containment.ts", // hand-written `startsWith(`${root}/`)` containment outside isWithin (#3423)
  "check-test-helpers.ts", // local copies of a test need that has a shared owner, against a shrinking baseline (#4835)
  "check-module-casts.ts", // `as` casts papering over the module config contract
  "check-leakage.ts", // personal strings anywhere in the tree (CI's leakage gate, runnable locally)
  "check-kit-purity.ts", // ui-kit stays prop-driven: no store, no I/O, no ambient globals
  "check-raw-buttons.ts", // raw <button> in ui-react needs a kit control or a raw-button marker (#1379)
  "check-root-stores.ts", // internal imperative store access must use an explicit root
  "check-layer-direction.ts", // ui-react stores/, lib/ and connection.ts never import components/ (#1380)
  "check-unused-exports.ts", // ui-server, ui-kit and ui-react exports no other file imports (#2536)
  "check-import-cycles.ts", // runtime import cycles between the source files of a package (#4816)
  "check-oxlint.ts", // oxlint correctness pass (ruleset in .oxlintrc.json)
  "check-ci-workflows.ts", // Single GitHub provider, safe fork execution and no active Depot definitions (#1320)
];

/**
 * The AST gates run in this process: one TypeScript load and one parser entry
 * (`scripts/lib/source.ts`) instead of one process each (#4673). Each exports
 * `lintGate(root)`, which prints what its standalone run prints and returns its
 * exit code. Every other gate keeps its own process.
 */
export const IN_PROCESS = new Set([
  "check-env-access.ts", "check-frontmatter-parse.ts", "check-inline-containment.ts", "check-module-casts.ts",
  "check-kit-purity.ts", "check-raw-buttons.ts", "check-root-stores.ts", "check-layer-direction.ts",
  "check-unused-exports.ts", "check-import-cycles.ts",
]);

type Gate = { lintGate(root: string): number };

/** Runs `lints` against `root` in order and returns whether any failed; a gate that throws fails without stopping the run. */
export async function runLints(root: string, lints: readonly string[] = LINTS,
  load: (path: string) => Promise<Gate> = path => import(path)): Promise<boolean> {
  let failed = false;
  for (const lint of lints) {
    const path = join(ROOT, "scripts", lint);
    console.log(`\n== ${lint}`);
    if (!existsSync(path)) {
      // A missing lint that "passes" is a silently disabled gate. Fail loudly.
      console.error(`scripts/${lint} does not exist — a lint listed in scripts/lint.ts is missing.`);
      failed = true;
      continue;
    }
    if (IN_PROCESS.has(lint)) {
      try {
        if ((await load(path)).lintGate(root) !== 0) failed = true;
      } catch (error) {
        console.error(`scripts/${lint} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        failed = true;
      }
      // One gate's trees are garbage once it returns; collect them before the next parses.
      Bun.gc(true);
      continue;
    }
    const run = Bun.spawnSync(["bun", path, root], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (run.exitCode !== 0) failed = true;
  }
  return failed;
}

if (import.meta.main) {
  if (await runLints(ROOT)) {
    console.error("\nlint: FAILED (see the gates above)");
    process.exit(1);
  }
  console.log("\nlint: all gates clean");
}
